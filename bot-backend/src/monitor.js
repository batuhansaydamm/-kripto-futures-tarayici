import { radarFeatures } from "./radar.js";

function trendOf(features) {
  if (!features) return 0;
  return features.e7 > features.e25 && features.e25 > features.e50
    ? 1
    : features.e7 < features.e25 && features.e25 < features.e50
      ? -1
      : 0;
}

function btcSideOf(btc15, btc1) {
  if (!btc15 || !btc1) return 0;
  return btc1.e7 > btc1.e25 && btc1.e25 > btc1.e50 && btc15.e7 > btc15.e25
    ? 1
    : btc1.e7 < btc1.e25 && btc1.e25 < btc1.e50 && btc15.e7 < btc15.e25
      ? -1
      : 0;
}

function liveVolumeContext(rows, direction, now = Date.now()) {
  const all = Array.isArray(rows) ? rows : [];
  const closed = all.filter((row) => Number(row[6]) < now);
  const current = all.at(-1);
  const base = closed
    .slice(-20)
    .map((row) => Number(row[7]) || Number(row[5]) * Number(row[4]));
  const baseAverage = base.length
    ? base.reduce((sum, value) => sum + value, 0) / base.length
    : 0;
  if (!current || Number(current[6]) < now || !(baseAverage > 0))
    return { pace: null, reversal: false, fading: false };

  const elapsed = Math.max(
    0.12,
    Math.min(1, (now - Number(current[0])) / (15 * 60 * 1000)),
  );
  const quoteVolume =
    Number(current[7]) || Number(current[5]) * Number(current[4]);
  const pace = quoteVolume / elapsed / baseAverage;
  const open = Number(current[1]);
  const high = Number(current[2]);
  const low = Number(current[3]);
  const close = Number(current[4]);
  const range = Math.max(high - low, Number.EPSILON);
  const bodyRatio = Math.abs(close - open) / range;
  const against = direction * (close - open) < 0;
  return {
    pace,
    reversal: against && pace >= 1.35 && bodyRatio >= 0.45,
    fading: elapsed >= 0.3 && pace <= 0.55,
  };
}

async function oiChangePct(marketClient, symbol) {
  try {
    const history = await marketClient.get("/futures/data/openInterestHist", {
      symbol,
      period: "15m",
      limit: 8,
    });
    if (!Array.isArray(history) || history.length < 2) return null;
    const first = Number(
      history[0]?.sumOpenInterestValue || history[0]?.sumOpenInterest,
    );
    const last = Number(
      history.at(-1)?.sumOpenInterestValue || history.at(-1)?.sumOpenInterest,
    );
    if (!(first > 0) || !(last > 0)) return null;
    return (last / first - 1) * 100;
  } catch {
    return null;
  }
}

/**
 * Açık bir pozisyonun güncel piyasa koşullarına göre durumunu değerlendirir.
 * Yalnız ANALİZ üretir; Binance'e hiçbir emir göndermez / iptal etmez / değiştirmez.
 * Çıktı, bir sonraki aşamada (gerçek emir aksiyonu) girdi olarak kullanılacak.
 */
export async function evaluatePosition(marketClient, trade, position) {
  const symbol = trade.symbol;
  const direction = trade.side === "LONG" ? 1 : -1;
  const entry = Number(trade.entryAveragePrice ?? trade.entry);
  const initialStop = Number(
    trade.initialStopPrice ?? trade.stopPrice ?? trade.stop,
  );
  const risk = Math.abs(entry - initialStop);
  const markPrice = Number(position?.markPrice) || entry;

  let k15;
  let h1;
  let btc15;
  let btc1;
  try {
    [k15, h1, btc15, btc1] = await Promise.all([
      marketClient.get("/fapi/v1/klines", {
        symbol,
        interval: "15m",
        limit: 120,
      }),
      marketClient.get("/fapi/v1/klines", {
        symbol,
        interval: "1h",
        limit: 100,
      }),
      marketClient.get("/fapi/v1/klines", {
        symbol: "BTCUSDT",
        interval: "15m",
        limit: 120,
      }),
      marketClient.get("/fapi/v1/klines", {
        symbol: "BTCUSDT",
        interval: "1h",
        limit: 100,
      }),
    ]);
  } catch (error) {
    return {
      ok: false,
      action: "HOLD",
      reason: `İzleme verisi alınamadı: ${error.message}`,
      evaluatedAt: Date.now(),
    };
  }

  const m15 = radarFeatures(k15);
  const m1 = radarFeatures(h1);
  const b15 = radarFeatures(btc15);
  const b1 = radarFeatures(btc1);
  if (!m15 || !m1)
    return {
      ok: false,
      action: "HOLD",
      reason: "15D/1S özellik hesaplanamadı, mevcut emirler korunuyor.",
      evaluatedAt: Date.now(),
    };

  const t15 = trendOf(m15);
  const t1 = trendOf(m1);
  const btcSide = symbol === "BTCUSDT" ? 0 : btcSideOf(b15, b1);
  const oiChg = await oiChangePct(marketClient, symbol);
  const volume = liveVolumeContext(k15, direction);

  const rNow = risk
    ? (direction * (markPrice - entry)) / risk
    : 0;

  const structureFlip = t15 === -direction && t1 === -direction;
  const btcAgainst = btcSide !== 0 && btcSide === -direction;
  const oiFading = oiChg !== null && oiChg <= -3 && rNow < 1;
  const volumeReversal = volume.reversal;
  const volumeFading = volume.fading;

  let action = "HOLD";
  let reason = "Yapı ve momentum pozisyon yönünü henüz bozmadı.";
  let suggestedStopR = null;
  let targetAction = null;
  let targetReason = "";

  if (structureFlip && (btcAgainst || oiFading || volumeReversal)) {
    action = "EARLY_EXIT_SUGGESTED";
    reason = `15D+1S yapı tersine döndü ve ${
      btcAgainst
        ? "BTC pozisyona karşı"
        : oiFading
          ? "OI katılımı düşüyor"
          : "canlı hacimli ters mum oluşuyor"
    }; TP/SL beklemeden erken çıkış değerlendirilebilir.`;
  } else if (volumeReversal && btcAgainst && rNow < 1) {
    action = "EARLY_EXIT_SUGGESTED";
    reason =
      "Canlı 15D mum hacimli biçimde pozisyona ters ve BTC de karşı yönde; erken çıkış.";
  } else if (structureFlip) {
    action = "TIGHTEN_STOP_SUGGESTED";
    reason = "15D+1S yapı pozisyona karşı döndü; stopu daraltmak düşünülebilir.";
  } else if (rNow >= 1.5) {
    action = "MOVE_STOP_TO_1R_SUGGESTED";
    reason = `Pozisyon +${rNow.toFixed(2)}R; stop +1R kâra çekilebilir.`;
    suggestedStopR = 1;
  } else if (rNow >= 1) {
    action = "MOVE_STOP_TO_BREAKEVEN_SUGGESTED";
    reason = `Pozisyon +${rNow.toFixed(2)}R; stop maliyete (breakeven) çekilebilir.`;
    suggestedStopR = 0;
  }

  if (
    action !== "EARLY_EXIT_SUGGESTED" &&
    rNow >= 1.25 &&
    rNow < 2.8 &&
    trade.runnerTargetMode !== "DEFENSIVE" &&
    t15 === direction &&
    t1 === direction &&
    !btcAgainst &&
    !volumeReversal &&
    volume.pace !== null &&
    volume.pace >= 1.25 &&
    (oiChg === null || oiChg >= 0)
  ) {
    targetAction = "EXTEND_RUNNER_TO_3R";
    targetReason =
      `Trend hizalı; canlı hacim temposu ${volume.pace.toFixed(2)}x ve katılım korunuyor.`;
  } else if (
    action !== "EARLY_EXIT_SUGGESTED" &&
    rNow >= 0.5 &&
    rNow < 1.8 &&
    (volumeFading || volumeReversal)
  ) {
    targetAction = "DEFENSIVE_RUNNER_TO_2R";
    targetReason = volumeReversal
      ? "Canlı hacimli ters mum nedeniyle runner hedefi savunmacı seviyeye çekildi."
      : "Canlı hacim katılımı zayıfladığı için runner hedefi savunmacı seviyeye çekildi.";
  }

  return {
    ok: true,
    action,
    reason,
    rNow: +rNow.toFixed(2),
    t15,
    t1,
    btcSide,
    oiChg: oiChg === null ? null : +oiChg.toFixed(2),
    liveVolumePace:
      volume.pace === null ? null : +volume.pace.toFixed(2),
    volumeReversal,
    volumeFading,
    structureFlip,
    btcAgainst,
    oiFading,
    suggestedStopR,
    targetAction,
    targetReason,
    evaluatedAt: Date.now(),
  };
}
