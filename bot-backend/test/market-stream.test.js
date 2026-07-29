import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamingMarketClient } from "../src/market-stream.js";

class FakeWebSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    this.listeners = new Map();
    this.sent = [];
  }
  addEventListener(name, fn) {
    const rows = this.listeners.get(name) || [];
    rows.push(fn);
    this.listeners.set(name, rows);
  }
  emit(name, value = {}) {
    for (const fn of this.listeners.get(name) || []) fn(value);
  }
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
  }
}

function client(fetchImpl = async () => {
  throw new Error("REST çağrısı beklenmiyordu");
}) {
  const market = new StreamingMarketClient({
    baseUrl: "https://fapi.binance.com",
    WebSocketImpl: FakeWebSocket,
    fetchImpl,
    minRequestIntervalMs: 0,
  });
  market.start();
  market.ws.emit("open");
  return market;
}

test("ticker ve funding akışlarını REST çağrısı olmadan sunar", async () => {
  const market = client();
  const tickers = Array.from({ length: 25 }, (_, index) => ({
    e: "24hrTicker",
    s: `C${index}USDT`,
    c: String(index + 1),
    P: String(index),
    q: String(1_000_000 + index),
  }));
  market.ws.emit("message", { data: JSON.stringify(tickers) });
  market.ws.emit("message", {
    data: JSON.stringify([
      { e: "markPriceUpdate", s: "C1USDT", p: "2", r: "0.0001", T: 123 },
    ]),
  });

  const rows = await market.get("/fapi/v1/ticker/24hr");
  const premium = await market.get("/fapi/v1/premiumIndex", {
    symbol: "C1USDT",
  });
  assert.equal(rows.length, 25);
  assert.equal(rows[1].lastPrice, "2");
  assert.equal(premium.lastFundingRate, "0.0001");
  market.stop();
});

test("evren değişince eski sembolleri unsubscribe, yenileri subscribe eder", () => {
  const market = client();
  market.setUniverse(["AAAUSDT"]);
  market.setUniverse(["BBBUSDT"]);
  const methods = market.ws.sent.map((row) => row.method);
  assert.ok(methods.includes("SUBSCRIBE"));
  assert.ok(methods.includes("UNSUBSCRIBE"));
  const removed = market.ws.sent
    .filter((row) => row.method === "UNSUBSCRIBE")
    .flatMap((row) => row.params);
  assert.ok(removed.includes("aaausdt@kline_15m"));
  market.stop();
});

test("mum geçmişi bir kez REST ile yüklenir, sonraki stream mumu cache'i günceller", async () => {
  let calls = 0;
  const now = Date.now();
  const fetchImpl = async () => {
    calls += 1;
    return new Response(
      JSON.stringify([[now - 900_000, "1", "2", "0.5", "1.5", "10", now - 1, "15", 1, "5", "7", "0"]]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const market = client(fetchImpl);
  const params = { symbol: "AAAUSDT", interval: "15m", limit: 120 };
  await market.get("/fapi/v1/klines", params);
  await market.get("/fapi/v1/klines", params);
  market.ws.emit("message", {
    data: JSON.stringify({
      e: "kline",
      s: "AAAUSDT",
      k: {
        i: "15m", t: now, T: now + 900_000, o: "1.5", h: "2", l: "1", c: "1.8",
        v: "12", q: "20", n: 2, V: "6", Q: "10",
      },
    }),
  });
  const rows = await market.get("/fapi/v1/klines", params);
  assert.equal(calls, 1);
  assert.equal(rows.at(-1)[4], "1.8");
  market.stop();
});

test("OI geçmişini 15 dakika TTL ile tekrar kullanır", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify([{ sumOpenInterest: "100" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const market = client(fetchImpl);
  const params = { symbol: "AAAUSDT", period: "15m", limit: 16 };
  await market.get("/futures/data/openInterestHist", params);
  await market.get("/futures/data/openInterestHist", params);
  assert.equal(calls, 1);
  market.stop();
});

test("mum akışında boşluk oluşursa seri yeniden REST ile tamamlanır", async () => {
  let calls = 0;
  const now = Date.now();
  const responseRows = () => [
    [now - 900_000, "1", "2", "0.5", "1.5", "10", now - 1, "15", 1, "5", "7", "0"],
  ];
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify(responseRows()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const market = client(fetchImpl);
  const params = { symbol: "AAAUSDT", interval: "15m", limit: 120 };
  await market.get("/fapi/v1/klines", params);
  market.ws.emit("message", {
    data: JSON.stringify({
      e: "kline",
      s: "AAAUSDT",
      k: {
        i: "15m", t: now + 2 * 900_000, T: now + 3 * 900_000,
        o: "1", h: "2", l: "0.5", c: "1.5", v: "10", q: "15",
        n: 1, V: "5", Q: "7",
      },
    }),
  });
  await market.get("/fapi/v1/klines", params);
  assert.equal(calls, 2);
  market.stop();
});
