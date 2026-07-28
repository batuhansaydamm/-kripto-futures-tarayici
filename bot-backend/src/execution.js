import { randomUUID } from "node:crypto";
import { floorToStep, roundToTick } from "./binance.js";

const terminalOrder = new Set(["FILLED", "CANCELED", "EXPIRED", "REJECTED"]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFill(client, symbol, initial, timeoutMs = 12_000) {
  let order = initial;
  const started = Date.now();
  while (order.status !== "FILLED" && Date.now() - started < timeoutMs) {
    if (terminalOrder.has(order.status)) break;
    await wait(500);
    order = await client.queryOrder(symbol, order.orderId);
  }
  if (order.status !== "FILLED")
    throw new Error(
      `Giriş emri FILLED olmadı: ${order.status || "UNKNOWN"} #${order.orderId}`,
    );
  return order;
}

async function emergencyClose(client, trade, reason) {
  const position = await client.positionRisk(trade.symbol);
  const amount = Math.abs(Number(position?.positionAmt || 0));
  if (!(amount > 0)) return { closed: true, reason, order: null };
  await client.cancelAll(trade.symbol).catch(() => null);
  const order = await client.newOrder({
    symbol: trade.symbol,
    side: trade.side === "LONG" ? "SELL" : "BUY",
    type: "MARKET",
    quantity: amount,
    reduceOnly: true,
    newClientOrderId: `V132-EMERGENCY-${randomUUID().slice(0, 12)}`,
  });
  return { closed: true, reason, order };
}

function splitQuantities(total, step) {
  const tp1 = floorToStep(total * 0.3, step);
  const tp2 = floorToStep(total * 0.3, step);
  const tp3 = floorToStep(total - tp1 - tp2, step);
  if (!(tp1 > 0) || !(tp2 > 0) || !(tp3 > 0))
    throw new Error("Pozisyon miktarı 30/30/40 çıkış için çok küçük.");
  return { tp1, tp2, tp3 };
}

export function buildDryRunPackage(candidate, rules, settings) {
  const notional = settings.marginUsdt * settings.leverage;
  const quantity = floorToStep(notional / candidate.entry, rules.stepSize);
  if (quantity < rules.minQty || quantity > rules.maxQty)
    throw new Error("Hesaplanan quantity sembol limitlerinin dışında.");
  if (quantity * candidate.entry < rules.minNotional)
    throw new Error("Hesaplanan pozisyon minimum notional altında.");
  const split = splitQuantities(quantity, rules.stepSize);
  return {
    proofLevel: "DRY_RUN",
    symbol: candidate.symbol,
    side: candidate.side,
    marginType: "ISOLATED",
    leverage: settings.leverage,
    marginUsdt: settings.marginUsdt,
    expectedNotional: quantity * candidate.entry,
    quantity,
    stopPrice: roundToTick(candidate.stop, rules.tickSize),
    targets: {
      tp1: {
        price: roundToTick(candidate.tp1, rules.tickSize),
        quantity: split.tp1,
      },
      tp2: {
        price: roundToTick(candidate.tp2, rules.tickSize),
        quantity: split.tp2,
      },
      tp3: {
        price: roundToTick(candidate.tp3, rules.tickSize),
        quantity: split.tp3,
      },
    },
  };
}

export async function executeProtectedTrade(
  client,
  candidate,
  settings,
  onProgress = async () => {},
) {
  const rules = await client.symbolRules(candidate.symbol);
  const package_ = buildDryRunPackage(candidate, rules, settings);
  if (settings.dryRun) return package_;

  await client.syncTime();
  const mode = await client.positionMode();
  if (mode?.dualSidePosition)
    throw new Error("Bot yalnız Binance One-way Mode ile çalışır; Hedge Mode açık.");
  const account = await client.account();
  const available = Number(account.availableBalance || 0);
  if (available < settings.marginUsdt)
    throw new Error(
      `Testnet kullanılabilir bakiye yetersiz: ${available.toFixed(2)} USDT`,
    );
  const existing = await client.positionRisk(candidate.symbol);
  if (Math.abs(Number(existing?.positionAmt || 0)) > 0)
    throw new Error(`${candidate.symbol} üzerinde zaten açık pozisyon var.`);

  await client.setMarginType(candidate.symbol, "ISOLATED");
  const leverageResult = await client.setLeverage(
    candidate.symbol,
    settings.leverage,
  );
  if (Number(leverageResult?.leverage) !== settings.leverage)
    throw new Error("Binance x10 leverage ayarını doğrulamadı.");

  const trade = {
    ...package_,
    proofLevel: "TESTNET_READY",
    clientTradeId: randomUUID(),
    createdAt: Date.now(),
    entryOrderId: null,
    stopOrderId: null,
    targetOrderIds: [],
  };
  try {
    const entry = await client.newOrder({
      symbol: trade.symbol,
      side: trade.side === "LONG" ? "BUY" : "SELL",
      type: "MARKET",
      quantity: trade.quantity,
      newClientOrderId: `V132-ENTRY-${trade.clientTradeId.slice(0, 12)}`,
    });
    trade.entryOrderId = entry.orderId;
    const filled = await waitForFill(client, trade.symbol, entry);
    trade.proofLevel = "ENTRY_FILLED";
    trade.entryAveragePrice = Number(filled.avgPrice || candidate.entry);
    await onProgress({ ...trade });

    const stop = await client.newOrder({
      symbol: trade.symbol,
      side: trade.side === "LONG" ? "SELL" : "BUY",
      type: "STOP_MARKET",
      stopPrice: trade.stopPrice,
      closePosition: true,
      workingType: "MARK_PRICE",
      priceProtect: true,
      newClientOrderId: `V132-STOP-${trade.clientTradeId.slice(0, 12)}`,
    });
    trade.stopOrderId = stop.orderId;
    const stopProof = await client.queryOrder(trade.symbol, stop.orderId);
    if (stopProof.status !== "NEW")
      throw new Error(`Stop emri NEW değil: ${stopProof.status}`);
    trade.stopStatus = stopProof.status;
    trade.proofLevel = "PROTECTED";
    await onProgress({ ...trade });

    for (const [name, target] of Object.entries(trade.targets)) {
      const order = await client.newOrder({
        symbol: trade.symbol,
        side: trade.side === "LONG" ? "SELL" : "BUY",
        type: "TAKE_PROFIT_MARKET",
        stopPrice: target.price,
        quantity: target.quantity,
        reduceOnly: true,
        workingType: "MARK_PRICE",
        priceProtect: true,
        newClientOrderId: `V132-${name.toUpperCase()}-${trade.clientTradeId.slice(0, 10)}`,
      });
      trade.targetOrderIds.push({ name, orderId: order.orderId });
      await onProgress({ ...trade });
    }
    return trade;
  } catch (error) {
    if (trade.entryOrderId) {
      const emergency = await emergencyClose(client, trade, error.message).catch(
        (closeError) => ({
          closed: false,
          reason: error.message,
          closeError: closeError.message,
        }),
      );
      error.emergency = emergency;
    }
    throw error;
  }
}
