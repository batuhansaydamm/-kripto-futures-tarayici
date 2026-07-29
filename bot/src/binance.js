import crypto from 'node:crypto';

const BASE_URLS = {
  testnet: 'https://testnet.binancefuture.com',
  live: 'https://fapi.binance.com'
};

function decimalPlaces(step) {
  const text = String(step);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  return (text.split('.')[1] || '').replace(/0+$/, '').length;
}

function floorToStep(value, step) {
  const precision = decimalPlaces(step);
  const floored = Math.floor((value + Number.EPSILON) / step) * step;
  return floored.toFixed(precision);
}

function roundToTick(value, tick) {
  const precision = decimalPlaces(tick);
  const rounded = Math.round(value / tick) * tick;
  return rounded.toFixed(precision);
}

export class BinanceFuturesClient {
  constructor({ env, apiKey, apiSecret, onApiError }) {
    this.baseUrl = BASE_URLS[env];
    if (!this.baseUrl) throw new Error(`Geçersiz BINANCE_ENV: ${env}`);
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.onApiError = onApiError;
    this.timeOffset = 0;
    this.symbolCache = new Map();
  }

  async publicRequest(path, params = {}) {
    return this.#request('GET', path, params, false);
  }

  async signedRequest(method, path, params = {}) {
    return this.#request(method, path, params, true);
  }

  async #request(method, path, params, signed) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    if (signed) {
      query.set('timestamp', String(Date.now() + this.timeOffset));
      query.set('recvWindow', '5000');
      const signature = crypto.createHmac('sha256', this.apiSecret).update(query.toString()).digest('hex');
      query.set('signature', signature);
    }
    const response = await fetch(`${this.baseUrl}${path}?${query}`, {
      method,
      headers: signed ? { 'X-MBX-APIKEY': this.apiKey } : undefined
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || (typeof body.code === 'number' && body.code < 0)) {
      this.onApiError?.({ method, path, status: response.status, code: body.code, message: body.msg });
      throw new Error(`Binance ${path}: ${body.code ?? response.status} ${body.msg ?? 'API error'}`);
    }
    return body;
  }

  async syncTime() {
    const server = await this.publicRequest('/fapi/v1/time');
    this.timeOffset = Number(server.serverTime) - Date.now();
    return this.timeOffset;
  }

  async getSymbolRules(symbol) {
    if (this.symbolCache.has(symbol)) return this.symbolCache.get(symbol);
    const info = await this.publicRequest('/fapi/v1/exchangeInfo');
    const item = info.symbols.find((entry) => entry.symbol === symbol);
    if (!item || item.status !== 'TRADING' || item.contractType !== 'PERPETUAL' || item.quoteAsset !== 'USDT') {
      throw new Error(`${symbol} TRADING/PERPETUAL/USDT şartlarını geçmiyor`);
    }
    const lot = item.filters.find((f) => f.filterType === 'MARKET_LOT_SIZE') || item.filters.find((f) => f.filterType === 'LOT_SIZE');
    const price = item.filters.find((f) => f.filterType === 'PRICE_FILTER');
    const notional = item.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
    const rules = {
      stepSize: Number(lot.stepSize),
      minQty: Number(lot.minQty),
      maxQty: Number(lot.maxQty),
      tickSize: Number(price.tickSize),
      minNotional: Number(notional?.notional || 5)
    };
    this.symbolCache.set(symbol, rules);
    return rules;
  }

  async markPrice(symbol) {
    const data = await this.publicRequest('/fapi/v1/premiumIndex', { symbol });
    return Number(data.markPrice);
  }

  async ensureOneWayMode() {
    const mode = await this.signedRequest('GET', '/fapi/v1/positionSide/dual');
    if (mode.dualSidePosition) throw new Error('Hedge mode açık. Bot ONE-WAY mode gerektiriyor.');
  }

  async ensureIsolatedAndLeverage(symbol, leverage) {
    try {
      await this.signedRequest('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' });
    } catch (error) {
      if (!error.message.includes('-4046')) throw error;
    }
    const result = await this.signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
    if (Number(result.leverage) !== Number(leverage)) throw new Error('Kaldıraç borsada doğrulanamadı');
  }

  async openMarket({ symbol, side, marginUsdt, leverage, clientOrderId }) {
    const rules = await this.getSymbolRules(symbol);
    const price = await this.markPrice(symbol);
    const rawQuantity = (marginUsdt * leverage) / price;
    const quantity = floorToStep(rawQuantity, rules.stepSize);
    if (Number(quantity) < rules.minQty || Number(quantity) > rules.maxQty) throw new Error('Quantity sembol limitlerinin dışında');
    if (Number(quantity) * price < rules.minNotional) throw new Error('Emir minNotional altında');
    const order = await this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side: side === 'LONG' ? 'BUY' : 'SELL',
      type: 'MARKET',
      quantity,
      newClientOrderId: clientOrderId,
      newOrderRespType: 'RESULT'
    });
    return { order, quantity: Number(quantity), referencePrice: price };
  }

  async placeEmergencyStop({ symbol, side, stopPrice, clientOrderId }) {
    const rules = await this.getSymbolRules(symbol);
    const normalizedStop = roundToTick(stopPrice, rules.tickSize);
    const order = await this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side: side === 'LONG' ? 'SELL' : 'BUY',
      type: 'STOP_MARKET',
      stopPrice: normalizedStop,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
      priceProtect: 'TRUE',
      newClientOrderId: clientOrderId
    });
    const verified = await this.signedRequest('GET', '/fapi/v1/order', { symbol, orderId: order.orderId });
    if (!['NEW', 'PARTIALLY_FILLED'].includes(verified.status)) throw new Error(`Stop doğrulanamadı: ${verified.status}`);
    return verified;
  }

  async emergencyClose({ symbol, side, quantity, clientOrderId }) {
    return this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side: side === 'LONG' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity,
      reduceOnly: 'true',
      newClientOrderId: clientOrderId,
      newOrderRespType: 'RESULT'
    });
  }

  async openPositions() {
    const rows = await this.signedRequest('GET', '/fapi/v2/positionRisk');
    return rows.filter((row) => Number(row.positionAmt) !== 0);
  }
}
