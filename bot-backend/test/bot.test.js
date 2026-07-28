import test from "node:test";
import assert from "node:assert/strict";
import { TradingBot } from "../src/bot.js";

test("eşzamanlı reconcile çağrıları aynı uzlaştırmayı yalnız bir kez çalıştırır", async () => {
  let positionChecks = 0;
  let incomeChecks = 0;
  const client = {
    async syncTime() {},
    async positionRisk() {
      positionChecks++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { symbol: "BTCUSDT", positionAmt: "0" };
    },
    async incomeHistory() {
      incomeChecks++;
      return [];
    },
    async cancelAll() {},
  };
  const store = {
    state: {
      openTrade: {
        symbol: "BTCUSDT",
        side: "LONG",
        proofLevel: "PROTECTED",
        createdAt: Date.now() - 60_000,
      },
      daily: { realizedPnl: 0 },
      consecutiveLosses: 0,
      enabled: true,
      killSwitch: false,
    },
    event() {},
    async save() {},
    rollDay() {},
  };
  const bot = new TradingBot({
    client,
    marketClient: client,
    store,
    config: {
      maxConsecutiveLosses: 2,
      maxDailyLossUsdt: 100,
      maxTotalTrades: 5,
      scanIntervalMs: 900_000,
      managementEnabled: true,
    },
  });

  await Promise.all([bot.reconcile(), bot.reconcile(), bot.reconcile()]);
  assert.equal(positionChecks, 1);
  assert.equal(incomeChecks, 1);
  assert.equal(store.state.openTrade, null);
});
