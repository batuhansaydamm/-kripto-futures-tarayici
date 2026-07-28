import { test } from "node:test";
import assert from "node:assert/strict";
import { applyManagementAction, closeImmediately } from "../src/manage.js";

const rules = { tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 100, minNotional: 5 };

function baseTrade(overrides = {}) {
  return {
    symbol: "BTCUSDT",
    side: "LONG",
    entry: 50_000,
    stop: 49_500,
    entryAveragePrice: 50_000,
    stopPrice: 49_500,
    initialStopPrice: 49_500,
    protectionLevel: "ORIGINAL",
    stopOrderId: 200,
    ...overrides,
  };
}

function makeClient({ failNewStopOrder = false, failCancelWithUnknown = false } = {}) {
  let orderId = 300;
  const calls = [];
  return {
    calls,
    async symbolRules() { return rules; },
    async cancelOrder(symbol, orderId_) {
      calls.push({ op: "cancelOrder", symbol, orderId: orderId_ });
      if (failCancelWithUnknown) {
        const error = new Error("Unknown order sent.");
        error.code = -2011;
        throw error;
      }
    },
    async newOrder(params) {
      calls.push({ op: "newOrder", ...params });
      if (params.type === "STOP_MARKET" && failNewStopOrder)
        throw new Error("Testnet reddetti");
      orderId++;
      return { orderId, status: "FILLED" };
    },
    async queryOrder(_symbol, id) {
      return { orderId: id, status: "NEW" };
    },
    async positionRisk() {
      const closed = calls.some(
        (call) => call.op === "newOrder" && call.type === "MARKET" && call.reduceOnly,
      );
      return {
        symbol: "BTCUSDT",
        positionAmt: closed ? "0" : "0.01",
        markPrice: "51000",
      };
    },
    async cancelAll(symbol) {
      calls.push({ op: "cancelAll", symbol });
    },
  };
}

test("BREAKEVEN sinyali stopu entry'nin biraz üstüne (LONG) taşır", async () => {
  const client = makeClient();
  const trade = baseTrade();
  const signal = { ok: true, action: "MOVE_STOP_TO_BREAKEVEN_SUGGESTED", reason: "test" };
  const outcome = await applyManagementAction(client, trade, signal);
  assert.equal(outcome.acted, true);
  assert.equal(outcome.kind, "BREAKEVEN");
  assert.equal(trade.protectionLevel, "BREAKEVEN");
  assert.ok(trade.stopPrice > 50_000, `yeni stop entry üstünde olmalı, geldi: ${trade.stopPrice}`);
  assert.equal(client.calls[0].op, "newOrder");
  assert.equal(client.calls[0].type, "STOP_MARKET");
  assert.equal(client.calls[0].closePosition, true);
  assert.equal(client.calls[1].op, "cancelOrder");
});

test("LOCKED_1R sinyali stopu entry+1R'a taşır", async () => {
  const client = makeClient();
  const trade = baseTrade({ protectionLevel: "BREAKEVEN", stopPrice: 50_025 });
  const signal = { ok: true, action: "MOVE_STOP_TO_1R_SUGGESTED", reason: "test" };
  const outcome = await applyManagementAction(client, trade, signal);
  assert.equal(outcome.acted, true);
  assert.equal(outcome.kind, "LOCKED_1R");
  assert.equal(trade.protectionLevel, "LOCKED_1R");
  // risk = |50000-49500| = 500, 1R hedefi = 50500
  assert.equal(trade.stopPrice, 50_500);
});

test("zaten LOCKED_1R iken tekrar BREAKEVEN istenirse aksiyon alınmaz (asla gevşetme)", async () => {
  const client = makeClient();
  const trade = baseTrade({ protectionLevel: "LOCKED_1R", stopPrice: 50_500 });
  const signal = { ok: true, action: "MOVE_STOP_TO_BREAKEVEN_SUGGESTED", reason: "test" };
  const outcome = await applyManagementAction(client, trade, signal);
  assert.equal(outcome.acted, false);
  assert.equal(trade.protectionLevel, "LOCKED_1R");
  assert.equal(trade.stopPrice, 50_500);
  assert.equal(client.calls.length, 0);
});

test("EARLY_EXIT sinyali tüm emirleri iptal edip market ile kapatır", async () => {
  const client = makeClient();
  const trade = baseTrade();
  const signal = { ok: true, action: "EARLY_EXIT_SUGGESTED", reason: "yapı bozuldu" };
  const outcome = await applyManagementAction(client, trade, signal);
  assert.equal(outcome.acted, true);
  assert.equal(outcome.kind, "EARLY_EXIT");
  assert.equal(client.calls[0].op, "newOrder");
  const marketCall = client.calls.find((c) => c.op === "newOrder");
  assert.equal(marketCall.type, "MARKET");
  assert.equal(marketCall.reduceOnly, true);
  assert.equal(marketCall.side, "SELL"); // LONG pozisyon kapatmak için SELL
  assert.equal(client.calls.at(-1).op, "cancelAll");
});

test("yeni stop emri reddedilirse eski stop iptal edilmez ve pozisyon korunur", async () => {
  const client = makeClient({ failNewStopOrder: true });
  const trade = baseTrade();
  const signal = { ok: true, action: "MOVE_STOP_TO_BREAKEVEN_SUGGESTED", reason: "test" };
  await assert.rejects(applyManagementAction(client, trade, signal));
  assert.equal(trade.stopOrderId, 200);
  assert.equal(trade.stopPrice, 49_500);
  assert.equal(client.calls.some((c) => c.op === "cancelOrder"), false);
  assert.equal(client.calls.some((c) => c.type === "MARKET"), false);
});

test("eski stop zaten yoksa (-2011) cancel hatası yutulur, yeni stop yine konur", async () => {
  const client = makeClient({ failCancelWithUnknown: true });
  const trade = baseTrade();
  const signal = { ok: true, action: "MOVE_STOP_TO_BREAKEVEN_SUGGESTED", reason: "test" };
  const outcome = await applyManagementAction(client, trade, signal);
  assert.equal(outcome.acted, true);
});

test("geçersiz sinyalde (ok:false) hiçbir aksiyon alınmaz", async () => {
  const client = makeClient();
  const trade = baseTrade();
  const signal = { ok: false, action: "HOLD", reason: "veri yok" };
  const outcome = await applyManagementAction(client, trade, signal);
  assert.equal(outcome.acted, false);
  assert.equal(client.calls.length, 0);
});

test("closeImmediately pozisyon zaten kapalıysa emir göndermez", async () => {
  const client = makeClient();
  client.positionRisk = async () => ({ symbol: "BTCUSDT", positionAmt: "0" });
  const trade = baseTrade();
  const result = await closeImmediately(client, trade, "test");
  assert.equal(result.closed, true);
  assert.equal(result.order, null);
  assert.equal(client.calls.length, 0);
});

test("hacim güçlenince TP3 runner hedefi 3R'a taşınır", async () => {
  const client = makeClient();
  const trade = baseTrade({
    targets: { tp3: { price: 51_250, quantity: 0.004 } },
    targetOrderIds: [{ name: "tp3", orderId: 250 }],
    runnerTargetR: 2.5,
  });
  const signal = {
    ok: true,
    action: "HOLD",
    reason: "trend sürüyor",
    targetAction: "EXTEND_RUNNER_TO_3R",
    targetReason: "hacim güçlü",
  };
  const outcome = await applyManagementAction(client, trade, signal);
  assert.equal(outcome.acted, true);
  assert.equal(outcome.kind, "RUNNER_EXTENDED");
  assert.equal(trade.runnerTargetR, 3);
  assert.equal(trade.targets.tp3.price, 51_500);
});
