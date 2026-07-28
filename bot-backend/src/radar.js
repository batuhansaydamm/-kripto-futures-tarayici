const avg = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const ema = (values, period) => {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  return values.reduce(
    (current, value, index) =>
      index ? value * k + current * (1 - k) : value,
    values[0],
  );
};
const closedRows = (rows, now = Date.now()) =>
  (Array.isArray(rows) ? rows : []).filter((row) => Number(row[6]) < now);

export function radarAtr(rows, period = 14) {
  const selected = rows.slice(-(period + 1));
  if (selected.length < 2) return 0;
  const tr = [];
  for (let i = 1; i < selected.length; i++) {
    const high = +selected[i][2];
    const low = +selected[i][3];
    const previousClose = +selected[i - 1][4];
    tr.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose),
      ),
    );
  }
  return avg(tr);
}

export function radarFeatures(rows) {
  const data = closedRows(rows);
  if (data.length < 55) return null;
  const closes = data.map((row) => +row[4]);
  const volumes = data.map((row) => +row[7] || +row[5] * +row[4]);
  const last = data.at(-1);
  const price = +last[4];
  const e7 = ema(closes, 7);
  const e25 = ema(closes, 25);
  const e50 = ema(closes, 50);
  const old = closes.slice(0, -3);
  const atr = radarAtr(data);
  const volumeBase = avg(volumes.slice(-21, -1));
  return {
    data,
    price,
    open: +last[1],
    high: +last[2],
    low: +last[3],
    e7,
    e25,
    e50,
    atr,
    atrPct: price ? atr / price : 0,
    volRatio: volumeBase ? volumes.at(-1) / volumeBase : 1,
    e7Slope: e7 - ema(old, 7),
    e25Slope: e25 - ema(old, 25),
    recentHigh: Math.max(...data.slice(-13, -1).map((row) => +row[2])),
    recentLow: Math.min(...data.slice(-13, -1).map((row) => +row[3])),
  };
}

export function radarAdxRegime(rows, period = 14) {
  const data = closedRows(rows);
  if (data.length < period * 3)
    return { valid: false, adx: 0, chop: 50, regime: "VERİ YETERSİZ" };
  const tr = [];
  const plusDm = [];
  const minusDm = [];
  for (let i = 1; i < data.length; i++) {
    const high = +data[i][2];
    const low = +data[i][3];
    const previousHigh = +data[i - 1][2];
    const previousLow = +data[i - 1][3];
    const previousClose = +data[i - 1][4];
    const up = high - previousHigh;
    const down = previousLow - low;
    tr.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose),
      ),
    );
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  let smTr = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smPlus = plusDm.slice(0, period).reduce((a, b) => a + b, 0);
  let smMinus = minusDm.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    smTr = smTr - smTr / period + tr[i];
    smPlus = smPlus - smPlus / period + plusDm[i];
    smMinus = smMinus - smMinus / period + minusDm[i];
    const plus = smTr ? (100 * smPlus) / smTr : 0;
    const minus = smTr ? (100 * smMinus) / smTr : 0;
    dx.push(plus + minus ? (100 * Math.abs(plus - minus)) / (plus + minus) : 0);
  }
  if (dx.length < period)
    return { valid: false, adx: 0, chop: 50, regime: "VERİ YETERSİZ" };
  let adx = avg(dx.slice(0, period));
  for (let i = period; i < dx.length; i++)
    adx = (adx * (period - 1) + dx[i]) / period;
  const recent = data.slice(-period);
  let trSum = 0;
  for (let i = 0; i < recent.length; i++) {
    const high = +recent[i][2];
    const low = +recent[i][3];
    const previousClose = i
      ? +recent[i - 1][4]
      : +data[data.length - period - 1][4];
    trSum += Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose),
    );
  }
  const highest = Math.max(...recent.map((row) => +row[2]));
  const lowest = Math.min(...recent.map((row) => +row[3]));
  const chop =
    highest > lowest
      ? (100 * Math.log10(trSum / (highest - lowest))) / Math.log10(period)
      : 100;
  let regime = "REG-4 GEÇİŞ";
  if (adx >= 35 && chop < 40) regime = "REG-2 YÜKSEK VOL EXPANSION";
  else if (adx >= 25 && chop < 52) regime = "REG-1 TREND";
  else if (adx < 20 || chop > 61.8) regime = "REG-3 RANGE";
  return { valid: true, adx: +adx.toFixed(1), chop: +chop.toFixed(1), regime };
}

function exhaustion(rows, feature) {
  const data = closedRows(rows);
  const last = data.at(-1);
  if (!last || !feature?.atr)
    return { longBlocked: false, shortBlocked: false, label: "YOK" };
  const open = +last[1];
  const high = +last[2];
  const low = +last[3];
  const close = +last[4];
  const range = Math.max(high - low, Number.EPSILON);
  const upper = (high - Math.max(open, close)) / range;
  const lower = (Math.min(open, close) - low) / range;
  const body = Math.abs(close - open) / range;
  const extension25 = (close - feature.e25) / feature.atr;
  const anchor = data.length >= 6 ? +data.at(-6)[4] : close;
  const impulse = (close - anchor) / feature.atr;
  const nearHigh =
    close >= Math.max(...data.slice(-50).map((row) => +row[2])) * 0.998;
  const nearLow =
    close <= Math.min(...data.slice(-50).map((row) => +row[3])) * 1.002;
  const climax = feature.volRatio >= 2.2;
  const longBlocked =
    (extension25 >= 3.2 && impulse >= 2.4) ||
    (nearHigh && climax && upper >= 0.38 && body <= 0.48);
  const shortBlocked =
    (extension25 <= -3.2 && impulse <= -2.4) ||
    (nearLow && climax && lower >= 0.38 && body <= 0.48);
  return {
    longBlocked,
    shortBlocked,
    label: longBlocked
      ? "LONG EXHAUSTION"
      : shortBlocked
        ? "SHORT EXHAUSTION"
        : "YOK",
  };
}

function btcContext(k15, k1) {
  const m15 = radarFeatures(k15);
  const h1 = radarFeatures(k1);
  if (!m15 || !h1) return { valid: false, side: 0, label: "BTC VERİ YOK" };
  const side =
    h1.e7 > h1.e25 && h1.e25 > h1.e50 && m15.e7 > m15.e25
      ? 1
      : h1.e7 < h1.e25 && h1.e25 < h1.e50 && m15.e7 < m15.e25
        ? -1
        : 0;
  return {
    valid: true,
    side,
    label: side > 0 ? "BTC YUKARI" : side < 0 ? "BTC AŞAĞI" : "BTC KARIŞIK",
  };
}

function utcMarketLevels(k15, k1, k4) {
  const closed15 = closedRows(k15);
  const closed1 = closedRows(k1);
  const closed4 = closedRows(k4);
  const latest = Number(closed15.at(-1)?.[0] || Date.now());
  const dayMs = 86_400_000;
  const dayStart = Math.floor(latest / dayMs) * dayMs;
  const prevDayStart = dayStart - dayMs;
  const weekStart =
    dayStart - ((new Date(dayStart).getUTCDay() + 6) % 7) * dayMs;
  const prevWeekStart = weekStart - 7 * dayMs;
  const between = (rows, start, end) =>
    rows.filter((row) => Number(row[0]) >= start && Number(row[0]) < end);
  const aggregate = (rows) =>
    rows.length
      ? {
          open: +rows[0][1],
          high: Math.max(...rows.map((row) => +row[2])),
          low: Math.min(...rows.map((row) => +row[3])),
        }
      : null;
  const currentDay = between(closed15, dayStart, dayStart + dayMs);
  const previousDay = aggregate(between(closed1, prevDayStart, dayStart));
  const currentWeek = aggregate(
    between(closed4, weekStart, weekStart + 7 * dayMs),
  );
  const previousWeek = aggregate(between(closed4, prevWeekStart, weekStart));
  const baseVolume = currentDay.reduce((sum, row) => sum + Number(row[5]), 0);
  const quoteVolume = currentDay.reduce(
    (sum, row) => sum + Number(row[7]),
    0,
  );
  return {
    dailyOpen: currentDay.length ? +currentDay[0][1] : 0,
    sessionVwap: baseVolume ? quoteVolume / baseVolume : 0,
    previousDay,
    weeklyOpen: currentWeek?.open || 0,
    previousWeek,
  };
}

function levelImportance(rows, level, atr) {
  if (!level || !atr) return { score: 0, touches: 0, rejected: 0 };
  const closed = closedRows(rows).slice(-80, -1);
  const tolerance = Math.max(atr * 0.14, level * 0.0008);
  const touched = closed.filter(
    (row) =>
      Math.abs(+row[2] - level) <= tolerance ||
      Math.abs(+row[3] - level) <= tolerance,
  );
  const rejected = touched.filter((row) => {
    const range = Math.max(+row[2] - +row[3], Number.EPSILON);
    const upper = +row[2] - Math.max(+row[1], +row[4]);
    const lower = Math.min(+row[1], +row[4]) - +row[3];
    return Math.max(upper, lower) / range >= 0.3;
  }).length;
  const avgVolume = avg(closed.slice(-20).map((row) => +row[5])) || 1;
  const defendedVolume = touched.length
    ? avg(touched.map((row) => +row[5])) / avgVolume
    : 0;
  const score =
    Math.min(3, touched.length) +
    Math.min(2, rejected) +
    (defendedVolume >= 1.35 ? 1 : 0);
  return { score, touches: touched.length, rejected, defendedVolume };
}

function structuralBarriers(k15, k1, k4, side, entry, atr) {
  if (!atr) return [];
  const closed = closedRows(k15).slice(-96);
  const levels = utcMarketLevels(k15, k1, k4);
  const direction = side === "LONG" ? 1 : -1;
  const tolerance = Math.max(atr * 0.16, entry * 0.0008);
  const touchCount = (price) =>
    closed.filter(
      (row) =>
        Math.abs(+row[2] - price) <= tolerance ||
        Math.abs(+row[3] - price) <= tolerance,
    ).length;
  const barriers = [];
  const add = (price, label, baseScore) => {
    price = Number(price);
    if (!price || direction * (price - entry) <= 0) return;
    barriers.push({ price, label, score: baseScore + Math.min(3, touchCount(price)) });
  };
  add(levels.dailyOpen, "Günlük açılış", 2);
  add(levels.sessionVwap, "Seans VWAP", 2);
  add(levels.previousDay?.high, "Önceki gün yüksek", 3);
  add(levels.previousDay?.low, "Önceki gün düşük", 3);
  add(levels.weeklyOpen, "Haftalık açılış", 3);
  add(levels.previousWeek?.high, "Önceki hafta yüksek", 4);
  add(levels.previousWeek?.low, "Önceki hafta düşük", 4);
  for (let i = 2; i < closed.length - 2; i++) {
    const high = +closed[i][2];
    const low = +closed[i][3];
    const swingHigh =
      high >= +closed[i - 1][2] &&
      high >= +closed[i - 2][2] &&
      high >= +closed[i + 1][2] &&
      high >= +closed[i + 2][2];
    const swingLow =
      low <= +closed[i - 1][3] &&
      low <= +closed[i - 2][3] &&
      low <= +closed[i + 1][3] &&
      low <= +closed[i + 2][3];
    if (side === "LONG" && swingHigh) add(high, "15D swing direnci", 1);
    if (side === "SHORT" && swingLow) add(low, "15D swing desteği", 1);
  }
  return barriers;
}

export function deriveStagedTargets(side, entry, risk, barriers) {
  const direction = side === "LONG" ? 1 : -1;
  if (!(risk > 0))
    return { tp1: entry, tp2: entry, tp3: entry, blockingBarrier: false };
  const withDistance = (barriers || [])
    .map((barrier) => ({
      ...barrier,
      distanceR: (direction * (barrier.price - entry)) / risk,
    }))
    .filter((barrier) => barrier.distanceR >= 0.2 && barrier.distanceR <= 3.5)
    .sort((a, b) => a.distanceR - b.distanceR);

  const blocking = withDistance.find(
    (barrier) => barrier.score >= 3 && barrier.distanceR < 0.45,
  );

  let safeR = 1;
  const primary = withDistance.find(
    (barrier) =>
      barrier.score >= 3 && barrier.distanceR >= 0.45 && barrier.distanceR < 1.05,
  );
  if (primary) safeR = Math.max(0.35, +(primary.distanceR * 0.86).toFixed(2));

  let mainR = 1.5;
  const secondary = withDistance.find(
    (barrier) =>
      barrier.score >= 3 &&
      barrier.distanceR > safeR + 0.25 &&
      barrier.distanceR < 1.55,
  );
  if (secondary)
    mainR = Math.max(safeR + 0.3, +(secondary.distanceR * 0.88).toFixed(2));

  const runnerR = 2.5;
  const price = (r) => entry + direction * risk * r;
  return {
    tp1: price(safeR),
    tp2: price(mainR),
    tp3: price(runnerR),
    safeR,
    mainR,
    runnerR,
    blockingBarrier: !!blocking,
    blockingLabel: blocking?.label || "",
    barrierUsedTp1: primary?.label || "",
    barrierUsedTp2: secondary?.label || "",
  };
}

export function bosQuality(k15, m15, side) {
  const level = side === "LONG" ? m15.recentHigh : m15.recentLow;
  const broken = side === "LONG" ? m15.price > level : m15.price < level;
  if (!broken) return { active: false, score: 0, level, label: "" };
  const importance = levelImportance(k15, level, m15.atr);
  return {
    active: true,
    score: importance.score,
    level,
    touches: importance.touches,
    label:
      side === "LONG"
        ? "15D yapı kırılımı (önceki tepe)"
        : "15D yapı kırılımı (önceki dip)",
  };
}

export function buildCandidate(symbol, ticker, k15, k1, marketContext) {
  const m15 = radarFeatures(k15);
  const h1 = radarFeatures(k1);
  if (!m15 || !h1 || !m15.atr || !h1.atr) return null;
  const regime = radarAdxRegime(k15);
  if (!regime.valid || regime.regime === "REG-3 RANGE") return null;
  const quoteVolume = +ticker.quoteVolume || 0;
  if (quoteVolume < 12_000_000) return null;
  const chg24 = +ticker.priceChangePercent || 0;
  let longScore = 0;
  let shortScore = 0;
  if (h1.e7 > h1.e25 && h1.e25 > h1.e50) longScore += 3;
  if (h1.e7 < h1.e25 && h1.e25 < h1.e50) shortScore += 3;
  if (h1.e7Slope > 0 && h1.e25Slope >= 0) longScore += 1.5;
  if (h1.e7Slope < 0 && h1.e25Slope <= 0) shortScore += 1.5;
  if (m15.e7 > m15.e25 && m15.price > m15.e50) longScore += 2;
  if (m15.e7 < m15.e25 && m15.price < m15.e50) shortScore += 2;
  if (m15.e7Slope > 0) longScore++;
  if (m15.e7Slope < 0) shortScore++;
  if (m15.price > m15.open) longScore += 0.5;
  if (m15.price < m15.open) shortScore += 0.5;
  if (m15.volRatio >= 0.55 && m15.volRatio <= 1.8) {
    longScore += 0.5;
    shortScore += 0.5;
  }
  const distance = Math.abs(m15.price - m15.e7) / m15.atr;
  if (distance <= 0.7) {
    if (m15.price >= m15.e25) longScore++;
    if (m15.price <= m15.e25) shortScore++;
  }
  const side = longScore >= shortScore ? "LONG" : "SHORT";
  let score = Math.max(longScore, shortScore);
  if (score < 6.5 || Math.abs(longScore - shortScore) < 2) return null;
  const direction = side === "LONG" ? 1 : -1;
  const exhausted = exhaustion(k15, m15);
  if (
    (direction > 0 && exhausted.longBlocked) ||
    (direction < 0 && exhausted.shortBlocked)
  ) return null;

  const bos = bosQuality(k15, m15, side);
  if (!bos.active || bos.score < 2) return null;
  score += Math.min(2, bos.score * 0.3);

  if (marketContext?.valid && marketContext.side) {
    score += marketContext.side === direction ? 0.5 : -1.25;
  }
  const minimum = regime.regime.includes("REG-2") ? 7.5 : 7;
  if (score < minimum) return null;
  const currentPrice = +ticker.lastPrice || m15.price;
  const currentDistance = Math.abs(currentPrice - m15.e7) / m15.atr;
  if (
    currentDistance > 0.8 ||
    Math.abs(currentPrice / m15.price - 1) > m15.atrPct * 0.55
  ) return null;
  const zoneHalf = m15.atr * 0.08;
  const structural = side === "LONG" ? m15.recentLow : m15.recentHigh;
  const atrStop = currentPrice - direction * m15.atr * 1.15;
  let stop =
    side === "LONG"
      ? Math.min(atrStop, structural - m15.atr * 0.08)
      : Math.max(atrStop, structural + m15.atr * 0.08);
  let stopPct = Math.abs(currentPrice - stop) / currentPrice;
  if (stopPct > 0.028) stop = currentPrice * (1 - direction * 0.028);
  if (stopPct < 0.006) stop = currentPrice * (1 - direction * 0.006);

  const barriers = structuralBarriers(k15, k1, [], side, currentPrice, m15.atr);
  const targets = deriveStagedTargets(
    side,
    currentPrice,
    Math.abs(currentPrice - stop),
    barriers,
  );
  if (targets.blockingBarrier) return null;

  return {
    symbol,
    side,
    score,
    type:
      score >= 8 && currentDistance <= 0.55
        ? "TREND DEVAMI"
        : "MOMENTUM FIRSATI",
    quoteVolume,
    chg24,
    entryLow: currentPrice - zoneHalf,
    entryHigh: currentPrice + zoneHalf,
    entry: currentPrice,
    stop,
    tp1: targets.tp1,
    tp2: targets.tp2,
    tp3: targets.tp3,
    targetBasis: {
      tp1: targets.barrierUsedTp1 || "Standart R planı",
      tp2: targets.barrierUsedTp2 || "Standart R planı",
    },
    barriers,
    bos,
    atrPct: m15.atrPct * 100,
    volumeRatio: m15.volRatio,
    regime: regime.regime,
    adx: regime.adx,
    chop: regime.chop,
    btcContext: marketContext?.label || "BTC VERİ YOK",
    evidenceMode: "HEURISTIC_UNCALIBRATED",
    context: {
      e7: m15.e7,
      atr: m15.atr,
      atrPct: m15.atrPct,
      candlePrice: m15.price,
      recentHigh: m15.recentHigh,
      recentLow: m15.recentLow,
    },
  };
}

export function enrichCandidate(candidate, k4, premium, oiHistory, taker) {
  const h4 = radarFeatures(k4);
  if (!h4) return null;
  const long = candidate.side === "LONG";
  const aligned = long
    ? h4.e7 > h4.e25 && h4.e25 >= h4.e50 && h4.e7Slope > 0
    : h4.e7 < h4.e25 && h4.e25 <= h4.e50 && h4.e7Slope < 0;
  if (!aligned) return null;
  candidate.score += 1.25;
  const fundingRaw = Number(premium?.lastFundingRate);
  if (
    !Number.isFinite(fundingRaw) ||
    !Array.isArray(oiHistory) ||
    oiHistory.length < 2 ||
    !Array.isArray(taker) ||
    taker.length < 2
  ) return null;
  const funding = fundingRaw * 100;
  if (Math.abs(funding) > 0.15) return null;
  if ((long && funding > 0.05) || (!long && funding < -0.05))
    candidate.score -= 0.75;
  const firstOi = Number(
    oiHistory[0]?.sumOpenInterestValue || oiHistory[0]?.sumOpenInterest,
  );
  const lastOi = Number(
    oiHistory.at(-1)?.sumOpenInterestValue || oiHistory.at(-1)?.sumOpenInterest,
  );
  if (!(firstOi > 0) || !(lastOi > 0)) return null;
  const oiChg = (lastOi / firstOi - 1) * 100;
  if (
    (long && candidate.chg24 > 20 && oiChg < -10) ||
    (!long && candidate.chg24 < -20 && oiChg < -10)
  ) return null;
  // Aday zaten bosQuality ile gerçek bir yapı kırılımı taşıyor (buildCandidate).
  // Momentum-expansion tanımı gereği bu kırılım yeni pozisyon katılımıyla (OI artışı)
  // desteklenmiyorsa hareket squeeze/pozisyon-kapanışı kaynaklı sayılır ve reddedilir.
  if (!(oiChg >= 0.5)) return null;
  candidate.score += Math.min(0.6, (oiChg - 0.5) * 0.2);
  const recentFlow = taker.slice(-4);
  const buys = recentFlow.reduce((sum, row) => sum + Number(row.buyVol || 0), 0);
  const sells = recentFlow.reduce(
    (sum, row) => sum + Number(row.sellVol || 0),
    0,
  );
  if (!(buys > 0) || !(sells > 0)) return null;
  const flowRatio = buys / sells;
  if ((long && flowRatio < 0.85) || (!long && flowRatio > 1.18)) return null;
  if (long ? flowRatio >= 1.04 : flowRatio <= 0.96) candidate.score += 0.65;
  if (long ? flowRatio < 0.88 : flowRatio > 1.14) candidate.score -= 0.75;
  if (candidate.volumeRatio < 0.55 || candidate.score < 9.5) return null;

  const weeklyLevels = utcMarketLevels([], [], k4);
  const direction = long ? 1 : -1;
  const weeklyBarriers = [];
  const addWeekly = (price, label, baseScore) => {
    price = Number(price);
    if (!price || direction * (price - candidate.entry) <= 0) return;
    weeklyBarriers.push({ price, label, score: baseScore });
  };
  addWeekly(weeklyLevels.weeklyOpen, "Haftalık açılış", 3);
  addWeekly(weeklyLevels.previousWeek?.high, "Önceki hafta yüksek", 4);
  addWeekly(weeklyLevels.previousWeek?.low, "Önceki hafta düşük", 4);

  const mergedBarriers = [...(candidate.barriers || []), ...weeklyBarriers];
  const risk = Math.abs(candidate.entry - candidate.stop);
  const targets = deriveStagedTargets(
    candidate.side,
    candidate.entry,
    risk,
    mergedBarriers,
  );
  if (targets.blockingBarrier) return null;

  return {
    ...candidate,
    funding,
    oiChg,
    flowRatio,
    dataQuality: "COMPLETE",
    ruleSet: "V13_EVIDENCE_1",
    barriers: mergedBarriers,
    tp1: targets.tp1,
    tp2: targets.tp2,
    tp3: targets.tp3,
    targetBasis: {
      tp1: targets.barrierUsedTp1 || candidate.targetBasis?.tp1 || "Standart R planı",
      tp2: targets.barrierUsedTp2 || candidate.targetBasis?.tp2 || "Standart R planı",
    },
  };
}

export function verifyBook(candidate, book, receivedAt = Date.now()) {
  const bid = Number(book?.bidPrice);
  const ask = Number(book?.askPrice);
  const quoteAt = Number(book?.time || receivedAt);
  if (
    !(bid > 0) ||
    !(ask >= bid) ||
    Math.abs(receivedAt - quoteAt) > 15_000
  ) return null;
  const fill = candidate.side === "LONG" ? ask : bid;
  const context = candidate.context;
  if (
    Math.abs(fill - context.e7) / context.atr > 0.8 ||
    Math.abs(fill / context.candlePrice - 1) > context.atrPct * 0.55 ||
    fill < candidate.entryLow ||
    fill > candidate.entryHigh
  ) return null;
  const direction = candidate.side === "LONG" ? 1 : -1;
  const structural =
    candidate.side === "LONG" ? context.recentLow : context.recentHigh;
  const atrStop = fill - direction * context.atr * 1.15;
  let stop =
    candidate.side === "LONG"
      ? Math.min(atrStop, structural - context.atr * 0.08)
      : Math.max(atrStop, structural + context.atr * 0.08);
  const stopPct = Math.abs(fill - stop) / fill;
  if (stopPct > 0.028) stop = fill * (1 - direction * 0.028);
  if (stopPct < 0.006) stop = fill * (1 - direction * 0.006);

  const risk = Math.abs(fill - stop);
  const targets = deriveStagedTargets(
    candidate.side,
    fill,
    risk,
    candidate.barriers,
  );
  if (targets.blockingBarrier) return null;

  return {
    ...candidate,
    entry: fill,
    stop,
    tp1: targets.tp1,
    tp2: targets.tp2,
    tp3: targets.tp3,
    targetBasis: {
      tp1: targets.barrierUsedTp1 || candidate.targetBasis?.tp1 || "Standart R planı",
      tp2: targets.barrierUsedTp2 || candidate.targetBasis?.tp2 || "Standart R planı",
    },
    bidAtSignal: bid,
    askAtSignal: ask,
    spreadPct: (ask / bid - 1) * 100,
    quoteAt,
    receivedAt,
    fillVerified: true,
  };
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        output[index] = await fn(items[index], index);
      } catch {
        output[index] = null;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return output;
}

export function selectScanUniverse(
  tickers,
  allowed,
  {
    minQuoteVolume = 12_000_000,
    gainers = 15,
    losers = 10,
    volumeLeaders = 5,
  } = {},
) {
  const eligible = tickers.filter((ticker) => {
    const quoteVolume = Number(ticker.quoteVolume);
    const change = Number(ticker.priceChangePercent);
    return (
      allowed.has(ticker.symbol) &&
      Number.isFinite(quoteVolume) &&
      quoteVolume >= minQuoteVolume &&
      Number.isFinite(change)
    );
  });
  const byChangeDesc = [...eligible].sort(
    (a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent),
  );
  const byChangeAsc = [...eligible].sort(
    (a, b) => Number(a.priceChangePercent) - Number(b.priceChangePercent),
  );
  const byVolumeDesc = [...eligible].sort(
    (a, b) => Number(b.quoteVolume) - Number(a.quoteVolume),
  );

  const selected = new Map();
  const add = (ticker, source) => {
    const existing = selected.get(ticker.symbol);
    if (existing) {
      existing.scanSources.push(source);
      return;
    }
    selected.set(ticker.symbol, { ...ticker, scanSources: [source] });
  };

  byChangeDesc.slice(0, gainers).forEach((ticker) => add(ticker, "GAINER"));
  byChangeAsc.slice(0, losers).forEach((ticker) => add(ticker, "LOSER"));
  byVolumeDesc
    .slice(0, volumeLeaders)
    .forEach((ticker) => add(ticker, "VOLUME"));

  return [...selected.values()];
}

export async function scanBestCandidate(client) {
  const [exchange, tickers, btc15, btc1] = await Promise.all([
    client.get("/fapi/v1/exchangeInfo"),
    client.get("/fapi/v1/ticker/24hr"),
    client.get("/fapi/v1/klines", {
      symbol: "BTCUSDT",
      interval: "15m",
      limit: 120,
    }),
    client.get("/fapi/v1/klines", {
      symbol: "BTCUSDT",
      interval: "1h",
      limit: 100,
    }),
  ]);
  const allowed = new Set(
    exchange.symbols
      .filter(
        (symbol) =>
          symbol.status === "TRADING" &&
          symbol.contractType === "PERPETUAL" &&
          symbol.quoteAsset === "USDT",
      )
      .map((symbol) => symbol.symbol),
  );
  const top = selectScanUniverse(tickers, allowed);
  const marketContext = btcContext(btc15, btc1);
  const preliminary = (
    await mapLimit(top, 4, async (ticker) => {
      const [k15, k1] = await Promise.all([
        client.get("/fapi/v1/klines", {
          symbol: ticker.symbol,
          interval: "15m",
          limit: 120,
        }),
        client.get("/fapi/v1/klines", {
          symbol: ticker.symbol,
          interval: "1h",
          limit: 100,
        }),
      ]);
      return buildCandidate(
        ticker.symbol,
        ticker,
        k15,
        k1,
        marketContext,
      );
    })
  )
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const enriched = (
    await mapLimit(preliminary, 3, async (candidate) => {
      const [k4, premium, oi, taker] = await Promise.all([
        client.get("/fapi/v1/klines", {
          symbol: candidate.symbol,
          interval: "4h",
          limit: 100,
        }),
        client.get("/fapi/v1/premiumIndex", { symbol: candidate.symbol }),
        client.get("/futures/data/openInterestHist", {
          symbol: candidate.symbol,
          period: "15m",
          limit: 16,
        }),
        client.get("/futures/data/takerlongshortRatio", {
          symbol: candidate.symbol,
          period: "15m",
          limit: 16,
        }),
      ]);
      return enrichCandidate(candidate, k4, premium, oi, taker);
    })
  )
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  for (const candidate of enriched) {
    const book = await client.get("/fapi/v1/ticker/bookTicker", {
      symbol: candidate.symbol,
    });
    const verified = verifyBook(candidate, book);
    if (verified) return verified;
  }
  return null;
}
