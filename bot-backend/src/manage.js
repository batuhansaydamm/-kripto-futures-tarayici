import { randomUUID } from "node:crypto";
import { roundToTick } from "./binance.js";

const LEVEL_RANK = { ORIGINAL: 0, BREAKEVEN: 1, LOCKED_1R: 2 };
const rankOf = (level) => LEVEL_RANK[level] ?? 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function riskUnit(trade) {
  const entry = Number(trade.entryAveragePrice ?? trade.entry);
  const initialStop = Number(
    trade.initialStopPrice ?? trade.stopPrice ?? trade.stop,
  );
  return Math.abs(entry - initialStop);
}

function levelPrice(trade, r) {
  const direction = trade.side === "LONG" ? 1 : -1;
  const entry = Number(trade.entryAveragePrice ?? trade.entry);
  return entry + direction * riskUnit(trade) * r;
}

// Yeni stop yalnız riski azaltan (kâr kilitleyen) yönde olmalı; asla gevşetilmez.
function isTighter(trade, newStopPrice) {
  const direction = trade.side === "LONG" ? 1 : -1;
  const currentStop = Number(trade.stopPrice ?? trade.stop);
  return direction * (newStopPrice - currentStop) > 0;
}

export async function closeImmediately(client, trade, reason) {
  const position = await client.positionRisk(trade.symbol);
  const amount = Math.abs(Number(position?.positionAmt || 0));
  if (!(amount > 0)) return { closed: true, reason: "Pozisyon zaten kapalı", order: null };
  const order = await client.newOrder({
    symbol: trade.symbol,
    side: trade.side === "LONG" ? "SELL" : "BUY",
    type: "MARKET",
    quantity: amount,
    reduceOnly: true,
    newClientOrderId: `V132-EARLYEXIT-${randomUUID().slice(0, 10)}`,
  });
  let remaining = amount;
  for (let attempt = 0; attempt < 4 && remaining > 0; attempt++) {
    if (attempt) await wait(250);
    const proof = await client.positionRisk(trade.symbol);
    remaining = Math.abs(Number(proof?.positionAmt || 0));
  }
  if (remaining > 0)
    throw new Error(`Acil market çıkışı pozisyonu kapatmadı; kalan miktar: ${remaining}`);
  await client.cancelAll(trade.symbol).catch(() => null);
  trade.earlyExit = { at: Date.now(), reason, orderId: order.orderId };
  return { closed: true, reason, order };
}

async function replaceStop(client, trade, newStopPrice, newLevel, reason) {
  const previousStopOrderId = trade.stopOrderId;
  const order = await client.newOrder({
    symbol: trade.symbol,
    side: trade.side === "LONG" ? "SELL" : "BUY",
    type: "STOP_MARKET",
    stopPrice: newStopPrice,
    closePosition: true,
    workingType: "MARK_PRICE",
    priceProtect: true,
    newClientOrderId: `V132-STOPADJ-${randomUUID().slice(0, 10)}`,
  });
  const proof = await client.queryOrder(trade.symbol, order.orderId);
  if (proof.status !== "NEW") {
    await client.cancelOrder(trade.symbol, order.orderId).catch(() => null);
    throw new Error(`Yeni stop NEW durumunda değil: ${proof.status}`);
  }

  let previousStopCancelWarning = "";
  if (previousStopOrderId) {
    try {
      await client.cancelOrder(trade.symbol, previousStopOrderId);
    } catch (error) {
      if (error.code !== -2011) previousStopCancelWarning = error.message;
    }
  }
  trade.stopOrderId = order.orderId;
  trade.stopPrice = newStopPrice;
  trade.protectionLevel = newLevel;
  trade.protectionHistory ??= [];
  trade.protectionHistory.push({
    at: Date.now(),
    level: newLevel,
    stopPrice: newStopPrice,
    reason,
    previousStopOrderId,
    previousStopCancelWarning: previousStopCancelWarning || null,
  });
  return { replaced: true, previousStopCancelWarning };
}

async function replaceRunnerTarget(client, trade, newRunnerR, reason) {
  const currentR = Number(trade.runnerTargetR || 2.5);
  if (Math.abs(currentR - newRunnerR) < 0.01)
    return { replaced: false, reason: "Runner hedefi zaten bu seviyede." };
  const targetRef = trade.targetOrderIds?.find((item) => item.name === "tp3");
  const target = trade.targets?.tp3;
  if (!targetRef?.orderId || !target?.quantity)
    return { replaced: false, reason: "TP3 emir kaydı bulunamadı." };

  const rules = await client.symbolRules(trade.symbol);
  const newPrice = roundToTick(levelPrice(trade, newRunnerR), rules.tickSize);
  const oldPrice = target.price;
  const oldOrderId = targetRef.orderId;
  try {
    await client.cancelOrder(trade.symbol, oldOrderId);
  } catch (error) {
    if (error.code === -2011)
      return { replaced: false, reason: "TP3 artık açık değil; güncelleme atlandı." };
    throw error;
  }

  try {
    const order = await client.newOrder({
      symbol: trade.symbol,
      side: trade.side === "LONG" ? "SELL" : "BUY",
      type: "TAKE_PROFIT_MARKET",
      stopPrice: newPrice,
      quantity: target.quantity,
      reduceOnly: true,
      workingType: "MARK_PRICE",
      priceProtect: true,
      newClientOrderId: `V132-TP3ADJ-${randomUUID().slice(0, 10)}`,
    });
    const proof = await client.queryOrder(trade.symbol, order.orderId);
    if (proof.status !== "NEW")
      throw new Error(`Yeni TP3 NEW durumunda değil: ${proof.status}`);
    targetRef.orderId = order.orderId;
    target.price = newPrice;
    trade.runnerTargetR = newRunnerR;
    trade.runnerTargetMode = newRunnerR <= 2 ? "DEFENSIVE" : "EXTENDED";
    trade.targetHistory ??= [];
    trade.targetHistory.push({
      at: Date.now(),
      name: "tp3",
      oldPrice,
      newPrice,
      runnerR: newRunnerR,
      reason,
    });
    return { replaced: true, newPrice };
  } catch (error) {
    try {
      const rollback = await client.newOrder({
        symbol: trade.symbol,
        side: trade.side === "LONG" ? "SELL" : "BUY",
        type: "TAKE_PROFIT_MARKET",
        stopPrice: oldPrice,
        quantity: target.quantity,
        reduceOnly: true,
        workingType: "MARK_PRICE",
        priceProtect: true,
        newClientOrderId: `V132-TP3ROLLBACK-${randomUUID().slice(0, 8)}`,
      });
      const rollbackProof = await client.queryOrder(trade.symbol, rollback.orderId);
      if (rollbackProof.status !== "NEW")
        throw new Error(`TP3 rollback NEW değil: ${rollbackProof.status}`);
      targetRef.orderId = rollback.orderId;
      return {
        replaced: false,
        rolledBack: true,
        reason: `TP3 güncellemesi başarısız, eski hedef geri kondu: ${error.message}`,
      };
    } catch (rollbackError) {
      const wrapped = new Error(
        `TP3 güncelleme ve geri alma başarısız: ${error.message}; ${rollbackError.message}`,
      );
      wrapped.targetProtectionLost = true;
      throw wrapped;
    }
  }
}

/**
 * monitor.js'in ürettiği sinyale göre gerçek emir aksiyonu uygular.
 * - EARLY_EXIT_SUGGESTED: tüm açık emirleri iptal edip pozisyonu piyasadan kapatır.
 * - MOVE_STOP_TO_BREAKEVEN_SUGGESTED / TIGHTEN_STOP_SUGGESTED: stopu maliyete (+0.05R tampon) çeker.
 * - MOVE_STOP_TO_1R_SUGGESTED: stopu +1R kâra kilitler.
 * Stop yalnız SIKILAŞTIRILIR, asla gevşetilmez. Aynı/geride bir seviye tekrar istenirse aksiyon alınmaz.
 */
export async function applyManagementAction(client, trade, signal) {
  if (!signal?.ok) return { acted: false, reason: "Sinyal geçersiz." };
  const currentRank = rankOf(trade.protectionLevel || "ORIGINAL");

  if (signal.action === "EARLY_EXIT_SUGGESTED") {
    const result = await closeImmediately(client, trade, signal.reason);
    return { acted: true, kind: "EARLY_EXIT", result };
  }

  const outcomes = [];
  if (
    (signal.action === "MOVE_STOP_TO_BREAKEVEN_SUGGESTED" ||
      signal.action === "TIGHTEN_STOP_SUGGESTED") &&
    currentRank < LEVEL_RANK.BREAKEVEN
  ) {
    const rules = await client.symbolRules(trade.symbol);
    const target = roundToTick(levelPrice(trade, 0.05), rules.tickSize);
    if (!isTighter(trade, target))
      return { acted: false, reason: "Hesaplanan breakeven mevcut stoptan daha gevşek, atlandı." };
    const result = await replaceStop(client, trade, target, "BREAKEVEN", signal.reason);
    outcomes.push({ kind: "BREAKEVEN", newStopPrice: target, ...result });
  }

  if (
    signal.action === "MOVE_STOP_TO_1R_SUGGESTED" &&
    currentRank < LEVEL_RANK.LOCKED_1R
  ) {
    const rules = await client.symbolRules(trade.symbol);
    const target = roundToTick(levelPrice(trade, 1), rules.tickSize);
    if (!isTighter(trade, target))
      return { acted: false, reason: "Hesaplanan +1R seviyesi mevcut stoptan daha gevşek, atlandı." };
    const result = await replaceStop(client, trade, target, "LOCKED_1R", signal.reason);
    outcomes.push({ kind: "LOCKED_1R", newStopPrice: target, ...result });
  }

  if (signal.targetAction === "EXTEND_RUNNER_TO_3R") {
    const result = await replaceRunnerTarget(client, trade, 3, signal.targetReason);
    if (result.replaced) outcomes.push({ kind: "RUNNER_EXTENDED", ...result });
  } else if (signal.targetAction === "DEFENSIVE_RUNNER_TO_2R") {
    const result = await replaceRunnerTarget(client, trade, 2, signal.targetReason);
    if (result.replaced) outcomes.push({ kind: "RUNNER_DEFENSIVE", ...result });
  }

  if (outcomes.length)
    return {
      acted: true,
      kind: outcomes.map((item) => item.kind).join("+"),
      newStopPrice: outcomes.find((item) => item.newStopPrice)?.newStopPrice,
      newTargetPrice: outcomes.find((item) => item.newPrice)?.newPrice,
      outcomes,
    };
  return { acted: false, reason: "Aksiyon gerekmiyor (HOLD veya seviye zaten uygulanmış)." };
}
