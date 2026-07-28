const baseUrl = process.env.BINANCE_BASE_URL || 'https://demo-fapi.binance.com';
const localUrl = `http://127.0.0.1:${process.env.PORT || 8080}`;
const dashboardToken = process.env.DASHBOARD_TOKEN || '';
const symbol = (process.env.AUTO_SYMBOL || 'BTCUSDT').toUpperCase();
const interval = process.env.AUTO_INTERVAL || '5m';
const pollMs = Math.max(30_000, Number(process.env.AUTO_POLL_MS || 60_000));
const stopPercent = Math.max(0.2, Number(process.env.AUTO_STOP_PERCENT || 0.8));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(body.error || body.msg || `HTTP ${response.status}`);
  return body;
}

function authHeaders(extra = {}) {
  return {
    ...(dashboardToken ? { Authorization: `Bearer ${dashboardToken}` } : {}),
    ...extra,
  };
}

async function waitForServer() {
  for (;;) {
    try {
      const health = await jsonFetch(`${localUrl}/health`);
      if (health.ok) return;
    } catch {}
    await sleep(2_000);
  }
}

async function buildSignal() {
  const candles = await jsonFetch(`${baseUrl}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=4`);
  if (!Array.isArray(candles) || candles.length < 3) throw new Error('Not enough candles');

  const previous = candles[candles.length - 2];
  const open = Number(previous[1]);
  const close = Number(previous[4]);
  const high = Number(previous[2]);
  const low = Number(previous[3]);
  if (![open, close, high, low].every(Number.isFinite)) throw new Error('Invalid candle data');

  const side = close >= open ? 'LONG' : 'SHORT';
  const referencePrice = close;
  const percentageStop = referencePrice * (stopPercent / 100);
  const candleBuffer = Math.max((high - low) * 0.25, percentageStop);
  const stopPrice = side === 'LONG' ? referencePrice - candleBuffer : referencePrice + candleBuffer;

  return {
    signalId: `auto-${symbol}-${previous[0]}-${side}`,
    symbol,
    side,
    referencePrice,
    stopPrice,
  };
}

async function tick() {
  const health = await jsonFetch(`${localUrl}/health`);
  if (!health.botEnabled || health.killSwitch) return;

  const status = await jsonFetch(`${localUrl}/api/status`, { headers: authHeaders() });
  if (status.state?.openTrade || status.remoteOpenPositions?.length) return;
  if (Number(status.state?.totalTrades || 0) >= Number(status.config?.maxTotalTrades || 5)) return;

  const signal = await buildSignal();
  const result = await jsonFetch(`${localUrl}/api/signals/execute`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(signal),
  });
  console.log('[auto-runner] Testnet position opened', JSON.stringify({ symbol: signal.symbol, side: signal.side, referencePrice: signal.referencePrice, stopPrice: signal.stopPrice, result }));
}

await waitForServer();
console.log(`[auto-runner] active: ${symbol} ${interval}, 50 USDT margin, x10 isolated`);

for (;;) {
  try {
    await tick();
  } catch (error) {
    console.error('[auto-runner]', error.message);
  }
  await sleep(pollMs);
}
