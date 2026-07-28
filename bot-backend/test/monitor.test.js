import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePosition } from "../src/monitor.js";

function kline(closeTime, close, volume = 100) {
  return [
    closeTime - 900_000, close, close, close, close, volume, closeTime,
    volume * close, 0, 0, 0, 0,
  ];
}

function series(count, { start = 100, step = 0 } = {}) {
  const now = Date.now();
  const rows = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    price += step;
    const closeTime = now - (count - i) * 900_000 - 1;
    rows.push(kline(closeTime, price));
  }
  return rows;
}

function makeMarketClient({ symbolStep, btcStep, oiChg }) {
  const symbolK15 = series(120, { start: 100, step: symbolStep });
  const symbolH1 = series(100, { start: 100, step: symbolStep * 4 });
  const btcK15 = series(120, { start: 60000, step: btcStep });
  const btcH1 = series(100, { start: 60000, step: btcStep * 4 });
  return {
    async get(path, params = {}) {
      if (path === "/futures/data/openInterestHist") {
        if (oiChg === null) return [];
        const base = 1000;
        const last = base * (1 + oiChg / 100);
        return [
          { sumOpenInterest: String(base) },
          { sumOpenInterest: String(last) },
        ];
      }
      if (params.symbol === "BTCUSDT") {
        return params.interval === "15m" ? btcK15 : btcH1;
      }
      return params.interval === "15m" ? symbolK15 : symbolH1;
    },
  };
}

test("yapı hizalı ve rNow düşükken HOLD döner", async () => {
  const client = makeMarketClient({ symbolStep: 0.5, btcStep: 0.5, oiChg: 1 });
  const trade = { symbol: "TESTUSDT", side: "LONG", entry: 100, stop: 98, entryAveragePrice: 100, stopPrice: 98 };
  const position = { markPrice: "100.5" }; // rNow ~ 0.25
  const result = await evaluatePosition(client, trade, position);
  assert.equal(result.ok, true);
  assert.equal(result.action, "HOLD");
  assert.equal(result.structureFlip, false);
});

test("+1R üzeri kârda breakeven önerisi döner", async () => {
  const client = makeMarketClient({ symbolStep: 0.5, btcStep: 0.5, oiChg: 1 });
  const trade = { symbol: "TESTUSDT", side: "LONG", entry: 100, stop: 98, entryAveragePrice: 100, stopPrice: 98 };
  const position = { markPrice: "102.1" }; // risk=2, rNow ~1.05
  const result = await evaluatePosition(client, trade, position);
  assert.equal(result.action, "MOVE_STOP_TO_BREAKEVEN_SUGGESTED");
  assert.equal(result.suggestedStopR, 0);
});

test("+1.5R üzeri kârda stopu 1R'a çekme önerisi döner", async () => {
  const client = makeMarketClient({ symbolStep: 0.5, btcStep: 0.5, oiChg: 1 });
  const trade = { symbol: "TESTUSDT", side: "LONG", entry: 100, stop: 98, entryAveragePrice: 100, stopPrice: 98 };
  const position = { markPrice: "103.1" }; // rNow ~1.55
  const result = await evaluatePosition(client, trade, position);
  assert.equal(result.action, "MOVE_STOP_TO_1R_SUGGESTED");
  assert.equal(result.suggestedStopR, 1);
});

test("15D+1S yapı pozisyona karşı dönerse TIGHTEN_STOP önerir", async () => {
  // LONG pozisyon ama sembol serisi düşüş trendinde (step negatif)
  const client = makeMarketClient({ symbolStep: -0.5, btcStep: 0.5, oiChg: 1 });
  const trade = { symbol: "TESTUSDT", side: "LONG", entry: 100, stop: 98, entryAveragePrice: 100, stopPrice: 98 };
  const position = { markPrice: "99" };
  const result = await evaluatePosition(client, trade, position);
  assert.equal(result.structureFlip, true);
  assert.equal(result.action, "TIGHTEN_STOP_SUGGESTED");
});

test("yapı bozulması + BTC karşı yönlüyse erken çıkış önerir", async () => {
  const client = makeMarketClient({ symbolStep: -0.5, btcStep: -0.5, oiChg: 1 });
  const trade = { symbol: "TESTUSDT", side: "LONG", entry: 100, stop: 98, entryAveragePrice: 100, stopPrice: 98 };
  const position = { markPrice: "99" };
  const result = await evaluatePosition(client, trade, position);
  assert.equal(result.structureFlip, true);
  assert.equal(result.btcAgainst, true);
  assert.equal(result.action, "EARLY_EXIT_SUGGESTED");
});

test("yapı bozulması + OI çöküşüyse erken çıkış önerir", async () => {
  const client = makeMarketClient({ symbolStep: -0.5, btcStep: 0.5, oiChg: -5 });
  const trade = { symbol: "TESTUSDT", side: "LONG", entry: 100, stop: 98, entryAveragePrice: 100, stopPrice: 98 };
  const position = { markPrice: "99" }; // rNow < 1, oiFading koşulu sağlanır
  const result = await evaluatePosition(client, trade, position);
  assert.equal(result.oiFading, true);
  assert.equal(result.action, "EARLY_EXIT_SUGGESTED");
});

test("veri çekme hatasında ok:false ve HOLD ile güvenli tarafta kalır", async () => {
  const failingClient = { async get() { throw new Error("ağ hatası"); } };
  const trade = { symbol: "TESTUSDT", side: "LONG", entry: 100, stop: 98, entryAveragePrice: 100, stopPrice: 98 };
  const result = await evaluatePosition(failingClient, trade, { markPrice: "100" });
  assert.equal(result.ok, false);
  assert.equal(result.action, "HOLD");
  assert.match(result.reason, /alınamadı/);
});
