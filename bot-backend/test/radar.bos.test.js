import { test } from "node:test";
import assert from "node:assert/strict";
import { bosQuality } from "../src/radar.js";

function kline({ open, high, low, close, volume, closeTime }) {
  return [
    closeTime - 900_000, open, high, low, close, volume, closeTime,
    volume * close, 0, 0, 0, 0,
  ];
}

function buildSeries(count, { level = 100, atr = 1 } = {}) {
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < count; i++) {
    const closeTime = now - (count - i) * 900_000 - 1;
    rows.push(
      kline({
        open: level - atr * 0.3,
        high: level + atr * 0.2,
        low: level - atr * 0.5,
        close: level - atr * 0.1,
        volume: 100,
        closeTime,
      }),
    );
  }
  return rows;
}

test("kırılım yoksa (fiyat recentHigh altında) bos.active false döner", () => {
  const k15 = buildSeries(60);
  const m15 = { price: 100, recentHigh: 105, recentLow: 95, atr: 1 };
  const bos = bosQuality(k15, m15, "LONG");
  assert.equal(bos.active, false);
});

test("recentHigh üzeri kapanış varsa bos.active true döner", () => {
  const k15 = buildSeries(60);
  const m15 = { price: 106, recentHigh: 105, recentLow: 95, atr: 1 };
  const bos = bosQuality(k15, m15, "LONG");
  assert.equal(bos.active, true);
  assert.equal(bos.level, 105);
});

test("SHORT yönünde recentLow altı kapanış kırılım sayılır", () => {
  const k15 = buildSeries(60);
  const m15 = { price: 94, recentHigh: 105, recentLow: 95, atr: 1 };
  const bos = bosQuality(k15, m15, "SHORT");
  assert.equal(bos.active, true);
  assert.equal(bos.level, 95);
});

test("hiç temas edilmemiş seviyede skor düşük çıkar (0'a yakın)", () => {
  const k15 = buildSeries(60, { level: 50 }); // seri 50 civarında, kırılım 105'te — hiç temas yok
  const m15 = { price: 106, recentHigh: 105, recentLow: 95, atr: 1 };
  const bos = bosQuality(k15, m15, "LONG");
  assert.equal(bos.active, true);
  assert.ok(bos.score <= 1, `düşük temas sayısında skor düşük olmalı, geldi: ${bos.score}`);
});
