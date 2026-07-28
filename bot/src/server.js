import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { BinanceFuturesClient } from './binance.js';
import { StateStore } from './state.js';

const required = ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'BOT_CONTROL_TOKEN'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} eksik`);
}

const config = {
  port: Number(process.env.PORT || 3000),
  env: process.env.BINANCE_ENV || 'testnet',
  liveTrading: process.env.LIVE_TRADING === 'true',
  marginUsdt: Number(process.env.TRADE_MARGIN_USDT || 50),
  leverage: Number(process.env.LEVERAGE || 10),
  maxTotalTrades: Number(process.env.MAX_TOTAL_TRADES || 5),
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS || 1),
  dailyLossLimit: Number(process.env.DAILY_LOSS_LIMIT_USDT || 50),
  maxConsecutiveLosses: Number(process.env.MAX_CONSECUTIVE_LOSSES || 2),
  maxApiErrors: Number(process.env.MAX_API_ERRORS || 5),
  stateFile: process.env.STATE_FILE || './data/state.json'
};

if (config.env !== 'testnet') throw new Error('İlk sürüm yalnız BINANCE_ENV=testnet ile çalışır');
if (config.liveTrading) throw new Error('İlk sürümde LIVE_TRADING=true yasak');
if (config.marginUsdt !== 50 || config.leverage !== 10) throw new Error('İlk deneme sabitleri: 50 USDT ve x10');
if (config.maxTotalTrades !== 5 || config.maxOpenPositions !== 1) throw new Error('İlk deneme limitleri: toplam 5, aynı anda 1');

const store = new StateStore(config.stateFile);
const client = new BinanceFuturesClient({
  env: config.env,
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
  onApiError(error) {
    store.state.apiErrors += 1;
    store.event('API_ERROR', error);
    if (store.state.apiErrors >= config.maxApiErrors) {
      store.state.killSwitch = true;
      store.event('KILL_SWITCH_API_ERRORS');
    }
  }
});

const app = express();
app.use(express.json({ limit: '64kb' }));

function auth(req, res, next) {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expected = process.env.BOT_CONTROL_TOKEN;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function clientId(prefix, symbol) {
  return `v132_${prefix}_${symbol}_${Date.now()}`.slice(0, 36);
}

function validateSignal(body) {
  const symbol = String(body.symbol || '').toUpperCase();
  const side = String(body.side || '').toUpperCase();
  const stopPrice = Number(body.stopPrice);
  const signalId = String(body.signalId || '');
  if (!/^[A-Z0-9]{5,20}USDT$/.test(symbol)) throw new Error('Geçersiz symbol');
  if (!['LONG', 'SHORT'].includes(side)) throw new Error('side LONG veya SHORT olmalı');
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) throw new Error('Geçersiz stopPrice');
  if (!signalId || signalId.length > 80) throw new Error('Geçersiz signalId');
  return { symbol, side, stopPrice, signalId };
}

function assertRiskGates(signal) {
  store.rolloverDay();
  const s = store.state;
  if (s.killSwitch) throw new Error('Kill switch aktif');
  if (s.totalTrades >= config.maxTotalTrades) throw new Error('Toplam 5 işlem limiti doldu');
  if (s.openPosition) throw new Error('Yerel durumda açık pozisyon var');
  if (s.daily.realizedPnl <= -Math.abs(config.dailyLossLimit)) throw new Error('Günlük zarar limiti doldu');
  if (s.consecutiveLosses >= config.maxConsecutiveLosses) throw new Error('Peş peşe zarar limiti doldu');
  if (s.apiErrors >= config.maxApiErrors) throw new Error('API hata devre kesicisi açık');
  if (s.events.some((event) => event.signalId === signal.signalId && event.type === 'ENTRY_ACCEPTED')) {
    throw new Error('Duplicate signalId');
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, env: config.env, liveTrading: false }));

app.get('/api/status', auth, async (_req, res) => {
  try {
    const exchangePositions = await client.openPositions();
    res.json({ config: { ...config, stateFile: undefined }, state: store.state, exchangePositions });
  } catch (error) {
    res.status(502).json({ error: error.message, state: store.state });
  }
});

app.post('/api/kill-switch', auth, (req, res) => {
  store.state.killSwitch = req.body?.enabled !== false;
  store.event(store.state.killSwitch ? 'KILL_SWITCH_ENABLED' : 'KILL_SWITCH_DISABLED');
  res.json({ killSwitch: store.state.killSwitch });
});

app.post('/api/signals', auth, async (req, res) => {
  let signal;
  try {
    signal = validateSignal(req.body);
    assertRiskGates(signal);

    await client.syncTime();
    await client.ensureOneWayMode();
    const exchangePositions = await client.openPositions();
    if (exchangePositions.length >= config.maxOpenPositions) throw new Error('Binance üzerinde açık pozisyon var');
    await client.ensureIsolatedAndLeverage(signal.symbol, config.leverage);

    store.event('ENTRY_ACCEPTED', { signalId: signal.signalId, symbol: signal.symbol, side: signal.side });
    const entry = await client.openMarket({
      symbol: signal.symbol,
      side: signal.side,
      marginUsdt: config.marginUsdt,
      leverage: config.leverage,
      clientOrderId: clientId('entry', signal.symbol)
    });

    store.state.totalTrades += 1;
    store.state.openPosition = {
      signalId: signal.signalId,
      symbol: signal.symbol,
      side: signal.side,
      quantity: entry.quantity,
      entryOrderId: entry.order.orderId,
      openedAt: new Date().toISOString()
    };
    store.event('ENTRY_FILLED', { signalId: signal.signalId, symbol: signal.symbol, orderId: entry.order.orderId });

    try {
      const stop = await client.placeEmergencyStop({
        symbol: signal.symbol,
        side: signal.side,
        stopPrice: signal.stopPrice,
        clientOrderId: clientId('stop', signal.symbol)
      });
      store.state.openPosition.stopOrderId = stop.orderId;
      store.event('STOP_VERIFIED', { signalId: signal.signalId, symbol: signal.symbol, orderId: stop.orderId });
      return res.status(201).json({ accepted: true, position: store.state.openPosition });
    } catch (stopError) {
      store.event('STOP_FAILED', { signalId: signal.signalId, symbol: signal.symbol, error: stopError.message });
      try {
        const close = await client.emergencyClose({
          symbol: signal.symbol,
          side: signal.side,
          quantity: entry.quantity,
          clientOrderId: clientId('panic', signal.symbol)
        });
        store.event('EMERGENCY_CLOSE_SENT', { signalId: signal.signalId, symbol: signal.symbol, orderId: close.orderId });
        store.state.openPosition = null;
        store.state.killSwitch = true;
        store.save();
      } catch (closeError) {
        store.state.killSwitch = true;
        store.event('EMERGENCY_CLOSE_FAILED', { signalId: signal.signalId, symbol: signal.symbol, error: closeError.message });
      }
      return res.status(502).json({ error: 'Stop doğrulanamadı; acil kapatma prosedürü çalıştı', detail: stopError.message });
    }
  } catch (error) {
    if (signal) store.event('SIGNAL_REJECTED', { signalId: signal.signalId, symbol: signal.symbol, error: error.message });
    res.status(400).json({ error: error.message });
  }
});

async function reconcileOnStartup() {
  await client.syncTime();
  await client.ensureOneWayMode();
  const exchangePositions = await client.openPositions();
  if (exchangePositions.length > 1) {
    store.state.killSwitch = true;
    store.event('RECONCILE_MULTIPLE_POSITIONS', { count: exchangePositions.length });
    return;
  }
  if (exchangePositions.length === 1 && !store.state.openPosition) {
    store.state.killSwitch = true;
    store.state.openPosition = { recovered: true, exchange: exchangePositions[0] };
    store.event('RECONCILE_UNKNOWN_POSITION', { symbol: exchangePositions[0].symbol });
  }
  if (exchangePositions.length === 0 && store.state.openPosition) {
    store.event('RECONCILE_LOCAL_POSITION_CLEARED', { symbol: store.state.openPosition.symbol });
    store.state.openPosition = null;
    store.save();
  }
}

reconcileOnStartup()
  .then(() => app.listen(config.port, () => console.log(`V13.2 Testnet bot :${config.port}`)))
  .catch((error) => {
    store.state.killSwitch = true;
    store.event('STARTUP_FAILED', { error: error.message });
    console.error(error.message);
    process.exit(1);
  });
