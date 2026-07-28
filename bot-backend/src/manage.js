import { randomUUID } from "node:crypto";
import { roundToTick } from "./binance.js";

const LEVEL_RANK = { ORIGINAL: 0, BREAKEVEN: 1, LOCKED_1R: 2 };
const rankOf = (level) => LEVEL_RANK[level] ?? 0;

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
  await client.cancelAll(trade.symbol).catch(() => null);
  const order = await client.newOrder({
    symbol: trade.symbol,
    side: trade.side === "LONG" ? "SELL" : "BUY",
    type: "MARKET",
    quantity: amount,
    reduceOnly: true,
    newClientOrderId: `V132-EARLYEXIT-${randomUUID().slice(0, 10)}`,
  });
  trade.earlyExit = { at: Date.now(), reason, orderId: order.orderId };
  return { closed: true, reason, order };
}

async function replaceStop(client, trade, newStopPrice, newLevel, reason) {
  if (trade.stopOrderId) {
    try {
      await client.cancelOrder(trade.symbol, trade.stopOrderId);
    } catch (error) {
      // -2011 Unknown order: zaten yok (dolmuş/iptal olmuş) — sorun değil, devam et.
      if (error.code !== -2011) throw error;
    }
  }
  try {
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
    if (proof.status !== "NEW")
      throw new Error(`Yeni stop NEW durumunda değil: ${proof.status}`);
    trade.stopOrderId = order.orderId;
    trade.stopPrice = newStopPrice;
    trade.protectionLevel = newLevel;
    trade.protectionHistory ??= [];
    trade.protectionHistory.push({
      at: Date.now(),
      level: newLevel,
      stopPrice: newStopPrice,
      reason,
    });
    return { replaced: true };
  } catch (error) {
    // Eski stop iptal edildi ama yenisi konamadı: pozisyon korumasız kalmasın.
    const emergency = await closeImmediately(
      client,
      trade,
      `Stop güncelleme başarısız: ${error.message}`,
    ).catch((closeError) => ({ closed: false, closeError: closeError.message }));
    const wrapped = new Error(`Stop güncelleme başarısız: ${error.message}`);
    wrapped.emergency = emergency;
    throw wrapped;
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

  if (
    (signal.action === "MOVE_STOP_TO_BREAKEVEN_SUGGESTED" ||
      signal.action === "TIGHTEN_STOP_SUGGESTED") &&
    currentRank < LEVEL_RANK.BREAKEVEN
  ) {
    const rules = await client.symbolRules(trade.symbol);
    const target = roundToTick(levelPrice(trade, 0.05), rules.tickSize);
    if (!isTighter(trade, target))
      return { acted: false, reason: "Hesaplanan breakeven mevcut stoptan daha gevşek, atlandı." };
    await replaceStop(client, trade, target, "BREAKEVEN", signal.reason);
    return { acted: true, kind: "BREAKEVEN", newStopPrice: target };
  }

  if (
    signal.action === "MOVE_STOP_TO_1R_SUGGESTED" &&
    currentRank < LEVEL_RANK.LOCKED_1R
  ) {
    const rules = await client.symbolRules(trade.symbol);
    const target = roundToTick(levelPrice(trade, 1), rules.tickSize);
    if (!isTighter(trade, target))
      return { acted: false, reason: "Hesaplanan +1R seviyesi mevcut stoptan daha gevşek, atlandı." };
    await replaceStop(client, trade, target, "LOCKED_1R", signal.reason);
    return { acted: true, kind: "LOCKED_1R", newStopPrice: target };
  }

  return { acted: false, reason: "Aksiyon gerekmiyor (HOLD veya seviye zaten uygulanmış)." };
}
