import { test } from "node:test";
import assert from "node:assert/strict";
import { selectScanUniverse } from "../src/radar.js";

function ticker(index, change, quoteVolume = 20_000_000) {
  return {
    symbol: `COIN${index}USDT`,
    priceChangePercent: String(change),
    quoteVolume: String(quoteVolume),
  };
}

test("tarama evreni 15 yükselen, 10 düşen ve 5 hacim liderinden oluşur", () => {
  const tickers = Array.from({ length: 40 }, (_, index) =>
    ticker(index, index - 20, 20_000_000 + index),
  );
  [18, 19, 20, 21, 22].forEach((index, rank) => {
    tickers[index].quoteVolume = String(100_000_000 - rank);
  });
  const allowed = new Set(tickers.map((row) => row.symbol));

  const selected = selectScanUniverse(tickers, allowed);
  const symbols = new Set(selected.map((row) => row.symbol));

  assert.equal(selected.length, 30);
  for (let index = 25; index < 40; index++)
    assert.ok(symbols.has(`COIN${index}USDT`), `gainer eksik: ${index}`);
  for (let index = 0; index < 10; index++)
    assert.ok(symbols.has(`COIN${index}USDT`), `loser eksik: ${index}`);
  for (let index = 18; index <= 22; index++)
    assert.ok(symbols.has(`COIN${index}USDT`), `hacim lideri eksik: ${index}`);
});

test("çakışan sembol yalnız bir kez taranır ve kaynakları korunur", () => {
  const tickers = [
    ticker(1, 20, 100_000_000),
    ticker(2, 10, 90_000_000),
    ticker(3, -10, 80_000_000),
    ticker(4, -20, 70_000_000),
  ];
  const allowed = new Set(tickers.map((row) => row.symbol));

  const selected = selectScanUniverse(tickers, allowed, {
    gainers: 1,
    losers: 1,
    volumeLeaders: 1,
  });

  assert.equal(selected.length, 2);
  assert.deepEqual(selected[0].scanSources, ["GAINER", "VOLUME"]);
  assert.deepEqual(selected[1].scanSources, ["LOSER"]);
});

test("izinsiz, düşük hacimli veya sayısal verisi bozuk semboller elenir", () => {
  const valid = ticker(1, 5, 20_000_000);
  const lowVolume = ticker(2, 10, 5_000_000);
  const invalidChange = ticker(3, 0, 30_000_000);
  invalidChange.priceChangePercent = "bozuk";
  const notAllowed = ticker(4, 15, 40_000_000);

  const selected = selectScanUniverse(
    [valid, lowVolume, invalidChange, notAllowed],
    new Set([valid.symbol, lowVolume.symbol, invalidChange.symbol]),
  );

  assert.deepEqual(selected.map((row) => row.symbol), [valid.symbol]);
});
