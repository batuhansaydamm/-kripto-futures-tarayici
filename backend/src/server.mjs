import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const cfg = {
  baseUrl: process.env.BINANCE_BASE_URL || 'https://demo-fapi.binance.com',
  apiKey: process.env.BINANCE_API_KEY || '',
  apiSecret: process.env.BINANCE_API_SECRET || '',
  liveTrading: process.env.LIVE_TRADING === 'true',
  botEnabled: process.env.BOT_ENABLED === 'true',
  marginUsdt: numberEnv('MARGIN_USDT', 50),
  leverage: numberEnv('LEVERAGE', 10),
  marginType: process.env.MARGIN_TYPE || 'ISOLATED',
  maxOpenPositions: numberEnv('MAX_OPEN_POSITIONS', 1),
  maxTotalTrades: numberEnv('MAX_TOTAL_TRADES', 5),
  maxDailyLossUsdt: numberEnv('MAX_DAILY_LOSS_USDT', 50),
  maxConsecutiveLosses: numberEnv('MAX_CONSECUTIVE_LOSSES', 3),
  maxApiErrors: numberEnv('MAX_API_ERRORS', 5),
  recvWindow: numberEnv('RECV_WINDOW', 5000),
  port: numberEnv('PORT', 8080),
  stateFile: resolve(process.env.STATE_FILE || './data/bot-state.json'),
  dashboardToken: process.env.DASHBOARD_TOKEN || '',
};

if (cfg.liveTrading) {
  throw new Error('Phase 1 forbids LIVE_TRADING=true. Use Binance Futures Testnet only.');
}
if (!cfg.baseUrl.includes('demo-fapi.binance.com')) {
  throw new Error('Phase 1 base URL must be https://demo-fapi.binance.com');
}
if (cfg.leverage !== 10 || cfg.marginUsdt !== 50 || cfg.maxOpenPositions !== 1 || cfg.maxTotalTrades !== 5) {
  throw new Error('Locked pilot parameters are 50 USDT, x10 isolated, max 1 open position, max 5 total trades.');
}

const initialState = {
  version: 1,
  totalTrades: 0,
  openTrade: null,
  consecutiveLosses: 0,
  dailyPnl: {},
  apiErrorCount: 0,
  killSwitch: false,
  killReason: null,
  processedSignalIds: [],
  events: [],
};

let state = await loadState();
let exchangeInfoCache = { value: null, expiresAt: 0 };
let operationLock = false;

function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(cfg.stateFile, 'utf8'));
    return { ...structuredClone(initialState), ...parsed };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persistState(initialState);
    return structuredClone(initialState);
  }
}

async function persistState(next = state) {
  await mkdir(dirname(cfg.stateFile), { recursive: true });
  const tmp = `${cfg.stateFile}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, cfg.stateFile);
}

async function record(type, details = {}) {
  state.events.push({ at: new Date().toISOString(), type, ...details });
  state.events = state.events.slice(-500);
  await persistState();
}

function safeEqual(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

function assertAuth(req) {
  if (!cfg.dashboardToken) return;
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(supplied, cfg.dashboardToken)) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
}

function qs(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') out.set(key, String(value));
  }
  return out.toString();
}

async function binance(path, { method = 'GET', params = {}, signed = false } = {}) {
  if (signed && (!cfg.apiKey || !cfg.apiSecret)) throw new Error('Binance Testnet API credentials are missing');
  const payload = { ...params };
  if (signed) {
    payload.timestamp = Date.now();
    payload.recvWindow = cfg.recvWindow;
  }
  let query = qs(payload);
  if (signed) {
    const signature = createHmac('sha256', cfg.apiSecret).update(query).digest('hex');
    query += `&signature=${signature}`;
  }
  const url = `${cfg.baseUrl}${path}${query ? `?${query}` : ''}`;
  const response = await fetch(url, {
    method,
    headers: signed ? { 'X-MBX-APIKEY': cfg.apiKey } : {},
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    const err = new Error(body.msg || `Binance HTTP ${response.status}`);
    err.statusCode = response.status;
    err.binanceCode = body.code;
    err.body = body;
    throw err;
  }
  state.apiErrorCount = 0;
  return body;
}

async function guardedBinance(...args) {
  try {
    return await binance(...args);
  } catch (error) {
    state.apiErrorCount += 1;
    await record('BINANCE_API_ERROR', { message: error.message, code: error.binanceCode ?? null });
    if (state.apiErrorCount >= cfg.maxApiErrors) {
      state.killSwitch = true;
      state.killReason = `API circuit breaker: ${state.apiErrorCount} consecutive errors`;
      await persistState();
    }
    throw error;
  }
}

async function getExchangeInfo() {
  if (exchangeInfoCache.value && Date.now() < exchangeInfoCache.expiresAt) return exchangeInfoCache.value;
  const value = await guardedBinance('/fapi/v1/exchangeInfo');
  exchangeInfoCache = { value, expiresAt: Date.now() + 15 * 60_000 };
  return value;
}

function decimalPlaces(step) {
  const normalized = String(step).replace(/0+$/, '');
  return normalized.includes('.') ? normalized.split('.')[1].length : 0;
}

function floorToStep(value, step) {
  const precision = decimalPlaces(step);
  const floored = Math.floor((value + Number.EPSILON) / step) * step;
  return floored.toFixed(precision);
}

function roundToTick(value, tick) {
  const precision = decimalPlaces(tick);
  return (Math.round(value / tick) * tick).toFixed(precision);
}

async function symbolRules(symbol) {
  const info = await getExchangeInfo();
  const item = info.symbols.find((x) => x.symbol === symbol);
  if (!item) throw new Error(`Unknown Binance symbol: ${symbol}`);
  if (item.status !== 'TRADING' || item.contractType !== 'PERPETUAL' || item.quoteAsset !== 'USDT') {
    throw new Error(`${symbol} is not an active USDT perpetual contract`);
  }
  const lot = item.filters.find((x) => x.filterType === 'MARKET_LOT_SIZE') || item.filters.find((x) => x.filterType === 'LOT_SIZE');
  const price = item.filters.find((x) => x.filterType === 'PRICE_FILTER');
  const notional = item.filters.find((x) => x.filterType === 'MIN_NOTIONAL');
  if (!lot || !price) throw new Error(`${symbol} filters are incomplete`);
  return {
    stepSize: Number(lot.stepSize),
    minQty: Number(lot.minQty),
    maxQty: Number(lot.maxQty),
    tickSize: Number(price.tickSize),
    minNotional: Number(notional?.notional || 0),
  };
}

async function currentPosition(symbol) {
  const rows = await guardedBinance('/fapi/v2/positionRisk', { signed: true, params: { symbol } });
  const row = rows.find((x) => x.symbol === symbol && x.positionSide === 'BOTH') || rows[0];
  return row || null;
}

async function openPositions() {
  const rows = await guardedBinance('/fapi/v2/positionRisk', { signed: true });
  return rows.filter((x) => x.positionSide === 'BOTH' && Math.abs(Number(x.positionAmt)) > 0);
}

async function ensureOneWayMode() {
  const mode = await guardedBinance('/fapi/v1/positionSide/dual', { signed: true });
  if (mode.dualSidePosition === true) throw new Error('Hedge mode is enabled. Switch the account to One-way Mode before starting the bot.');
}

async function ensureMarginAndLeverage(symbol) {
  try {
    await guardedBinance('/fapi/v1/marginType', {
      method: 'POST', signed: true, params: { symbol, marginType: 'ISOLATED' },
    });
  } catch (error) {
    if (error.binanceCode !== -4046) throw error; // already isolated
  }
  const lev = await guardedBinance('/fapi/v1/leverage', {
    method: 'POST', signed: true, params: { symbol, leverage: 10 },
  });
  if (Number(lev.leverage) !== 10) throw new Error(`Leverage verification failed for ${symbol}`);
}

function clientOrderId(prefix, signalId) {
  return `v132-${prefix}-${signalId.slice(0, 12)}-${Date.now().toString(36)}`.slice(0, 36);
}

async function queryOrder(symbol, origClientOrderId) {
  return guardedBinance('/fapi/v1/order', { signed: true, params: { symbol, origClientOrderId } });
}

async function emergencyClose(symbol, side, reason) {
  const pos = await currentPosition(symbol);
  const amount = Math.abs(Number(pos?.positionAmt || 0));
  if (!amount) {
    await record('EMERGENCY_CLOSE_NOT_NEEDED', { symbol, reason });
    state.openTrade = null;
    await persistState();
    return;
  }
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  const id = clientOrderId('panic', randomUUID());
  await guardedBinance('/fapi/v1/order', {
    method: 'POST', signed: true,
    params: { symbol, side: closeSide, type: 'MARKET', quantity: amount, reduceOnly: true, newClientOrderId: id },
  });
  state.killSwitch = true;
  state.killReason = `Emergency close: ${reason}`;
  state.openTrade = null;
  await record('EMERGENCY_CLOSE', { symbol, reason, clientOrderId: id });
}

function assertTradingGate(signal) {
  if (!cfg.botEnabled) throw new Error('BOT_ENABLED=false');
  if (state.killSwitch) throw new Error(`Kill switch active: ${state.killReason || 'manual'}`);
  if (state.totalTrades >= cfg.maxTotalTrades) throw new Error('Permanent pilot limit reached: 5 total trades');
  if (state.openTrade) throw new Error('Local state already has an open trade');
  if (state.processedSignalIds.includes(signal.signalId)) throw new Error('Duplicate signalId');
  const daily = Number(state.dailyPnl[todayUtc()] || 0);
  if (daily <= -Math.abs(cfg.maxDailyLossUsdt)) throw new Error('Daily loss limit reached');
  if (state.consecutiveLosses >= cfg.maxConsecutiveLosses) throw new Error('Consecutive loss limit reached');
  if (!['LONG', 'SHORT'].includes(signal.side)) throw new Error('side must be LONG or SHORT');
  if (!Number.isFinite(signal.referencePrice) || signal.referencePrice <= 0) throw new Error('referencePrice must be positive');
  if (!Number.isFinite(signal.stopPrice) || signal.stopPrice <= 0) throw new Error('stopPrice must be positive');
  if (signal.side === 'LONG' && signal.stopPrice >= signal.referencePrice) throw new Error('LONG stop must be below referencePrice');
  if (signal.side === 'SHORT' && signal.stopPrice <= signal.referencePrice) throw new Error('SHORT stop must be above referencePrice');
}

async function executeSignal(signal) {
  assertTradingGate(signal);
  const remoteOpen = await openPositions();
  if (remoteOpen.length >= cfg.maxOpenPositions) throw new Error('Binance already has an open position');
  await ensureOneWayMode();
  const rules = await symbolRules(signal.symbol);
  await ensureMarginAndLeverage(signal.symbol);

  const notional = cfg.marginUsdt * cfg.leverage;
  const quantity = floorToStep(notional / signal.referencePrice, rules.stepSize);
  const quantityNumber = Number(quantity);
  if (quantityNumber < rules.minQty || quantityNumber > rules.maxQty) throw new Error('Calculated quantity violates Binance lot-size limits');
  if (quantityNumber * signal.referencePrice < rules.minNotional) throw new Error('Calculated order is below Binance minimum notional');

  const entrySide = signal.side === 'LONG' ? 'BUY' : 'SELL';
  const exitSide = signal.side === 'LONG' ? 'SELL' : 'BUY';
  const entryId = clientOrderId('entry', signal.signalId);
  const stopId = clientOrderId('stop', signal.signalId);
  const stopPrice = roundToTick(signal.stopPrice, rules.tickSize);

  const entry = await guardedBinance('/fapi/v1/order', {
    method: 'POST', signed: true,
    params: {
      symbol: signal.symbol,
      side: entrySide,
      type: 'MARKET',
      quantity,
      newOrderRespType: 'RESULT',
      newClientOrderId: entryId,
    },
  });

  state.totalTrades += 1;
  state.processedSignalIds.push(signal.signalId);
  state.processedSignalIds = state.processedSignalIds.slice(-1000);
  state.openTrade = {
    signalId: signal.signalId,
    symbol: signal.symbol,
    side: signal.side,
    quantity,
    entryClientOrderId: entryId,
    stopClientOrderId: stopId,
    openedAt: new Date().toISOString(),
  };
  await record('ENTRY_ACCEPTED', { symbol: signal.symbol, side: signal.side, quantity, entryOrderId: entry.orderId });

  try {
    await guardedBinance('/fapi/v1/order', {
      method: 'POST', signed: true,
      params: {
        symbol: signal.symbol,
        side: exitSide,
        type: 'STOP_MARKET',
        stopPrice,
        closePosition: true,
        workingType: 'MARK_PRICE',
        priceProtect: true,
        newClientOrderId: stopId,
      },
    });
    const verified = await queryOrder(signal.symbol, stopId);
    if (!verified || !['NEW', 'PARTIALLY_FILLED', 'FILLED'].includes(verified.status)) {
      throw new Error(`Stop verification returned status ${verified?.status || 'missing'}`);
    }
    await record('STOP_VERIFIED', { symbol: signal.symbol, stopPrice, stopOrderId: verified.orderId });
  } catch (error) {
    await emergencyClose(signal.symbol, signal.side, `Protective stop could not be verified: ${error.message}`);
    throw error;
  }

  if (state.totalTrades >= cfg.maxTotalTrades) {
    await record('PILOT_ENTRY_LIMIT_REACHED', { totalTrades: state.totalTrades });
  }
  return { entry, stopClientOrderId: stopId, totalTrades: state.totalTrades };
}

async function reconcile() {
  const remote = await openPositions();
  if (remote.length > 1) {
    state.killSwitch = true;
    state.killReason = `Reconciliation found ${remote.length} open positions`;
  } else if (remote.length === 1 && !state.openTrade) {
    state.killSwitch = true;
    state.killReason = `Unmanaged Binance position detected: ${remote[0].symbol}`;
  } else if (remote.length === 0 && state.openTrade) {
    await record('LOCAL_OPEN_TRADE_CLEARED', { symbol: state.openTrade.symbol });
    state.openTrade = null;
  }
  await persistState();
  return remote;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if (raw.length > 64_000) throw new Error('Request body too large');
  return JSON.parse(raw);
}

function send(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, environment: 'BINANCE_FUTURES_TESTNET', botEnabled: cfg.botEnabled, killSwitch: state.killSwitch });
    }
    assertAuth(req);
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const remote = cfg.apiKey && cfg.apiSecret ? await reconcile() : [];
      return send(res, 200, { config: { marginUsdt: 50, leverage: 10, marginType: 'ISOLATED', maxOpenPositions: 1, maxTotalTrades: 5, liveTrading: false }, state, remoteOpenPositions: remote });
    }
    if (req.method === 'POST' && url.pathname === '/api/signals/execute') {
      if (operationLock) return send(res, 409, { ok: false, error: 'Another trading operation is in progress' });
      operationLock = true;
      try {
        const body = await readJson(req);
        const signal = {
          signalId: String(body.signalId || randomUUID()),
          symbol: String(body.symbol || '').toUpperCase().trim(),
          side: String(body.side || '').toUpperCase().trim(),
          referencePrice: Number(body.referencePrice),
          stopPrice: Number(body.stopPrice),
        };
        const result = await executeSignal(signal);
        return send(res, 201, { ok: true, result });
      } finally {
        operationLock = false;
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/kill-switch') {
      const body = await readJson(req);
      state.killSwitch = true;
      state.killReason = String(body.reason || 'Manual kill switch');
      await record('KILL_SWITCH_ENABLED', { reason: state.killReason });
      return send(res, 200, { ok: true, state });
    }
    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    console.error('[bot-error]', error.message);
    return send(res, error.statusCode || 400, { ok: false, error: error.message, binanceCode: error.binanceCode ?? null });
  }
});

await reconcile().catch(async (error) => {
  state.killSwitch = true;
  state.killReason = `Startup reconciliation failed: ${error.message}`;
  await persistState();
});

server.listen(cfg.port, '0.0.0.0', () => {
  console.log(`V13.2 Binance Testnet executor listening on :${cfg.port}`);
});
