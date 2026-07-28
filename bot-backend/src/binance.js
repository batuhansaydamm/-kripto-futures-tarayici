import { createHmac } from "node:crypto";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BinanceError extends Error {
  constructor(message, { status = 0, code = null, payload = null } = {}) {
    super(message);
    this.name = "BinanceError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export class BinanceClient {
  constructor({
    baseUrl,
    apiKey = "",
    apiSecret = "",
    fetchImpl = fetch,
    minRequestIntervalMs = 0,
  }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.fetch = fetchImpl;
    this.minRequestIntervalMs = minRequestIntervalMs;
    this.requestQueue = Promise.resolve();
    this.lastRequestAt = 0;
    this.timeOffset = 0;
    this.exchangeInfoCache = null;
  }

  async throttle() {
    if (!(this.minRequestIntervalMs > 0)) return;
    const turn = this.requestQueue.then(async () => {
      const waitMs = Math.max(
        0,
        this.lastRequestAt + this.minRequestIntervalMs - Date.now(),
      );
      if (waitMs) await sleep(waitMs);
      this.lastRequestAt = Date.now();
    });
    this.requestQueue = turn.catch(() => {});
    await turn;
  }

  async request(method, path, params = {}, { signed = false, retries = 2 } = {}) {
    const values = { ...params };
    if (signed) {
      if (!this.apiKey || !this.apiSecret)
        throw new Error("Signed Binance isteği için Testnet anahtarları eksik.");
      values.recvWindow ??= 5000;
      values.timestamp = Date.now() + this.timeOffset;
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== null && value !== "")
        query.set(key, String(value));
    }
    if (signed) {
      const signature = createHmac("sha256", this.apiSecret)
        .update(query.toString())
        .digest("hex");
      query.set("signature", signature);
    }
    const url = `${this.baseUrl}${path}${query.size ? `?${query}` : ""}`;
    let response;
    try {
      await this.throttle();
      response = await this.fetch(url, {
        method,
        headers: this.apiKey ? { "X-MBX-APIKEY": this.apiKey } : {},
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (retries > 0) {
        await sleep(500 * (3 - retries));
        return this.request(method, path, params, { signed, retries: retries - 1 });
      }
      throw new BinanceError(`Binance bağlantısı başarısız: ${error.message}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && retries > 0) {
        await sleep(700 * (3 - retries));
        return this.request(method, path, params, { signed, retries: retries - 1 });
      }
      throw new BinanceError(
        payload?.msg || `Binance HTTP ${response.status}`,
        { status: response.status, code: payload?.code, payload },
      );
    }
    return payload;
  }

  get(path, params, options) {
    return this.request("GET", path, params, options);
  }
  post(path, params, options) {
    return this.request("POST", path, params, options);
  }
  delete(path, params, options) {
    return this.request("DELETE", path, params, options);
  }

  async syncTime() {
    const before = Date.now();
    const data = await this.get("/fapi/v1/time");
    const after = Date.now();
    this.timeOffset = Number(data.serverTime) - Math.round((before + after) / 2);
    return this.timeOffset;
  }

  async exchangeInfo(force = false) {
    if (!force && this.exchangeInfoCache) return this.exchangeInfoCache;
    this.exchangeInfoCache = await this.get("/fapi/v1/exchangeInfo");
    return this.exchangeInfoCache;
  }

  async symbolRules(symbol) {
    const info = await this.exchangeInfo();
    const item = info.symbols.find((x) => x.symbol === symbol);
    if (
      !item ||
      item.status !== "TRADING" ||
      item.contractType !== "PERPETUAL" ||
      item.quoteAsset !== "USDT"
    ) throw new Error(`${symbol} aktif USDT perpetual değil.`);
    const filter = (name) => item.filters.find((x) => x.filterType === name) || {};
    const marketLot = filter("MARKET_LOT_SIZE");
    const lot = Number(marketLot.stepSize) > 0 ? marketLot : filter("LOT_SIZE");
    return {
      symbol,
      tickSize: Number(filter("PRICE_FILTER").tickSize),
      stepSize: Number(lot.stepSize),
      minQty: Number(lot.minQty),
      maxQty: Number(lot.maxQty),
      minNotional: Number(
        filter("MIN_NOTIONAL").notional || filter("NOTIONAL").minNotional || 0,
      ),
    };
  }

  async account() {
    return this.get("/fapi/v2/account", {}, { signed: true });
  }
  async positionMode() {
    return this.get(
      "/fapi/v1/positionSide/dual",
      {},
      { signed: true },
    );
  }
  async positionRisk(symbol) {
    const rows = await this.get(
      "/fapi/v2/positionRisk",
      { symbol },
      { signed: true },
    );
    return Array.isArray(rows) ? rows.find((x) => x.symbol === symbol) : rows;
  }
  async incomeHistory({ symbol, startTime, incomeType = "REALIZED_PNL" }) {
    return this.get(
      "/fapi/v1/income",
      { symbol, startTime, incomeType, limit: 1000 },
      { signed: true },
    );
  }
  async setMarginType(symbol, marginType = "ISOLATED") {
    try {
      return await this.post(
        "/fapi/v1/marginType",
        { symbol, marginType },
        { signed: true },
      );
    } catch (error) {
      if (error.code === -4046) return { code: -4046, msg: "already isolated" };
      throw error;
    }
  }
  setLeverage(symbol, leverage) {
    return this.post(
      "/fapi/v1/leverage",
      { symbol, leverage },
      { signed: true },
    );
  }
  newOrder(params) {
    return this.post(
      "/fapi/v1/order",
      { ...params, newOrderRespType: params.newOrderRespType || "RESULT" },
      { signed: true },
    );
  }
  queryOrder(symbol, orderId) {
    return this.get(
      "/fapi/v1/order",
      { symbol, orderId },
      { signed: true },
    );
  }
  cancelAll(symbol) {
    return this.delete(
      "/fapi/v1/allOpenOrders",
      { symbol },
      { signed: true },
    );
  }
  cancelOrder(symbol, orderId) {
    return this.delete(
      "/fapi/v1/order",
      { symbol, orderId },
      { signed: true },
    );
  }
}

export function floorToStep(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
    throw new Error("Geçersiz step yuvarlama girdisi");
  const precision = Math.max(0, (String(step).split(".")[1] || "").length);
  return Number((Math.floor((value + 1e-12) / step) * step).toFixed(precision));
}

export function roundToTick(value, tick) {
  if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0)
    throw new Error("Geçersiz tick yuvarlama girdisi");
  const precision = Math.max(0, (String(tick).split(".")[1] || "").length);
  return Number((Math.round(value / tick) * tick).toFixed(precision));
}
