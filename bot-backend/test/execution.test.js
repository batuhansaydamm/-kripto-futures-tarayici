import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDryRunPackage,
  executeProtectedTrade,
  rebasePackageAfterFill,
} from "../src/execution.js";
import { floorToStep, roundToTick } from "../src/binance.js";

const candidate = {
  symbol: "BTCUSDT",
  side: "LONG",
  entry: 50_000,
  stop: 49_500,
  tp1: 50_500,
  tp2: 51_000,
  tp3: 51_500,
};
const rules = {
  tickSize: 0.1,
  stepSize: 0.001,
  minQty: 0.001,
  maxQty: 100,
  minNotional: 5,
};
const settings = { marginUsdt: 50, leverage: 10, dryRun: true };

test("step ve tick yuvarlaması aşağı/nearest çalışır", () => {
  assert.equal(floorToStep(1.23456, 0.001), 1.234);
  assert.equal(roundToTick(49_500.06, 0.1), 49_500.1);
});

test("dry-run paketi 50 USDT x10 ve 30/30/40 üretir", () => {
  const result = buildDryRunPackage(candidate, rules, settings);
  assert.equal(result.proofLevel, "DRY_RUN");
  assert.equal(result.quantity, 0.01);
  assert.equal(result.expectedNotional, 500);
  assert.equal(result.targets.tp1.quantity, 0.003);
  assert.equal(result.targets.tp2.quantity, 0.003);
  assert.equal(result.targets.tp3.quantity, 0.004);
});

function protectedMock({ rejectStop = false } = {}) {
  let orderId = 100;
  const calls = [];
  return {
    calls,
    async symbolRules() { return rules; },
    async syncTime() { return 0; },
    async positionMode() { return { dualSidePosition: false }; },
    async account() { return { availableBalance: "1000" }; },
    async positionRisk() {
      const entered = calls.some((x) => x.type === "MARKET" && !x.reduceOnly);
      const closed = calls.some((x) => x.type === "MARKET" && x.reduceOnly);
      return {
        symbol: "BTCUSDT",
        positionAmt: entered && !closed ? "0.01" : "0",
      };
    },
    async setMarginType(symbol, marginType) {
      calls.push({ op: "margin", symbol, marginType });
      return {};
    },
    async setLeverage(symbol, leverage) {
      calls.push({ op: "leverage", symbol, leverage });
      return { leverage };
    },
    async newOrder(params) {
      calls.push(params);
      orderId++;
      return {
        orderId,
        status: params.type === "MARKET" ? "FILLED" : "NEW",
        avgPrice: params.type === "MARKET" ? "50000" : "0",
      };
    },
    async queryOrder(_symbol, id) {
      if (id === 102)
        return { orderId: id, status: rejectStop ? "REJECTED" : "NEW" };
      if (id === 101)
        return { orderId: id, status: "FILLED", avgPrice: "50000" };
      return { orderId: id, status: "NEW" };
    },
    async cancelAll() {
      calls.push({ op: "cancelAll" });
    },
  };
}

test("korumalı zincir isolated → x10 → entry → stop proof → 3 TP sırasını izler", async () => {
  const client = protectedMock();
  const progress = [];
  const result = await executeProtectedTrade(
    client,
    candidate,
    { ...settings, dryRun: false },
    async (x) => progress.push(x.proofLevel),
  );
  assert.equal(result.proofLevel, "PROTECTED");
  assert.ok(result.entryOrderId);
  assert.ok(result.stopOrderId);
  assert.equal(result.targetOrderIds.length, 3);
  assert.deepEqual(progress.slice(0, 2), ["ENTRY_FILLED", "PROTECTED"]);
  assert.equal(client.calls[0].op, "margin");
  assert.equal(client.calls[1].op, "leverage");
  assert.equal(client.calls[2].type, "MARKET");
  assert.equal(client.calls[3].type, "STOP_MARKET");
});

test("gerçek fill sonrası stop ve hedefler gerçek ortalama fiyata yeniden bazlanır", () => {
  const package_ = buildDryRunPackage(candidate, rules, settings);
  rebasePackageAfterFill(package_, candidate, 50_100, rules);
  assert.equal(package_.stopPrice, 49_600);
  assert.equal(package_.targets.tp1.price, 50_600);
  assert.equal(package_.targets.tp2.price, 51_100);
  assert.equal(package_.targets.tp3.price, 51_600);
  assert.equal(package_.fillDeviationR, 0.2);
});

test("gerçek fill 0.35R'den fazla saparsa seviyeler kullanılmaz", () => {
  const package_ = buildDryRunPackage(candidate, rules, settings);
  assert.throws(
    () => rebasePackageAfterFill(package_, candidate, 50_200, rules),
    (error) => error.code === "FILL_DEVIATION",
  );
});

test("stop doğrulanmazsa hata verir ve acil market kapatma çağırır", async () => {
  const client = protectedMock({ rejectStop: true });
  await assert.rejects(
    executeProtectedTrade(client, candidate, { ...settings, dryRun: false }),
    (error) => {
      assert.equal(error.emergency.closed, true);
      return true;
    },
  );
  assert.ok(client.calls.some((x) => x.op === "cancelAll"));
  assert.ok(
    client.calls.some(
      (x) => x.type === "MARKET" && x.reduceOnly === true,
    ),
  );
});
