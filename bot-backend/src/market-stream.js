import { BinanceClient, BinanceError } from "./binance.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cacheKey = (path, params = {}) =>
  `${path}?${new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b)),
  )}`;

function tickerRow(row) {
  return {
    symbol: row.s,
    lastPrice: row.c,
    priceChangePercent: row.P,
    quoteVolume: row.q,
  };
}

function klineRow(k) {
  return [
    k.t,
    k.o,
    k.h,
    k.l,
    k.c,
    k.v,
    k.T,
    k.q,
    k.n,
    k.V,
    k.Q,
    "0",
  ];
}

/**
 * Production market data transport.
 *
 * Live ticker, mark/funding, order-book and candle updates use Binance's
 * WebSocket. REST is only used to bootstrap historical candles and for the
 * low-frequency derivatives series that have no equivalent public stream.
 */
export class StreamingMarketClient {
  constructor({
    baseUrl,
    streamUrl = "wss://fstream.binance.com/ws",
    fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket,
    minRequestIntervalMs = 1_000,
    cachePath = "./data/market-cache.json",
    now = () => Date.now(),
  }) {
    if (!WebSocketImpl) throw new Error("WebSocket desteği bulunamadı.");
    this.rest = new BinanceClient({
      baseUrl,
      fetchImpl,
      minRequestIntervalMs,
    });
    this.streamUrl = streamUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.cachePath = cachePath;
    this.ws = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.requestId = 1;
    this.lastMessageAt = 0;
    this.status = "STARTING";
    this.tickers = new Map();
    this.marks = new Map();
    this.books = new Map();
    this.klines = new Map();
    this.gappedSeries = new Set();
    this.ttl = new Map();
    this.activeUniverse = new Set();
    this.subscriptions = new Set(["!ticker@arr", "!markPrice@arr@1s"]);
  }

  get cooldownUntil() {
    return this.rest.cooldownUntil;
  }

  set cooldownUntil(value) {
    this.rest.cooldownUntil = Number(value || 0);
  }

  start() {
    this.closed = false;
    this.connect();
    return this;
  }

  async loadCache() {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, "utf8"));
      for (const [key, rows] of Object.entries(parsed?.klines || {})) {
        if (Array.isArray(rows) && rows.length) this.klines.set(key, rows);
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        console.warn(JSON.stringify({ event: "MARKET_CACHE_LOAD_FAILED", message: error.message }));
    }
  }

  async saveCache() {
    const payload = {
      savedAt: this.now(),
      klines: Object.fromEntries(this.klines),
    };
    await mkdir(dirname(this.cachePath), { recursive: true });
    const temporary = `${this.cachePath}.tmp`;
    await writeFile(temporary, JSON.stringify(payload));
    await rename(temporary, this.cachePath);
  }

  stop() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  health() {
    return {
      status: this.status,
      connected: this.ws?.readyState === this.WebSocketImpl.OPEN,
      lastMessageAt: this.lastMessageAt || null,
      tickerCount: this.tickers.size,
      universeSize: this.activeUniverse.size,
      candleSeries: this.klines.size,
      restCooldownUntil: this.cooldownUntil || null,
    };
  }

  connect() {
    if (this.closed) return;
    this.status = "CONNECTING";
    const ws = new this.WebSocketImpl(this.streamUrl);
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (ws !== this.ws) return;
      this.status = "CONNECTED";
      this.reconnectAttempt = 0;
      this.send("SUBSCRIBE", [...this.subscriptions]);
    });
    ws.addEventListener("message", (event) => {
      if (ws !== this.ws) return;
      this.lastMessageAt = this.now();
      this.consume(event.data);
    });
    const reconnect = () => {
      if (ws !== this.ws || this.closed) return;
      this.status = "DISCONNECTED";
      const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt++);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref?.();
    };
    ws.addEventListener("close", reconnect);
    ws.addEventListener("error", () => {
      this.status = "ERROR";
      try {
        ws.close();
      } catch {
        reconnect();
      }
    });
  }

  send(method, params) {
    if (!params.length || this.ws?.readyState !== this.WebSocketImpl.OPEN) return;
    this.ws.send(JSON.stringify({ method, params, id: this.requestId++ }));
  }

  consume(raw) {
    let data;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (Array.isArray(data)) {
      if (!data.length) return;
      if ("P" in data[0] && "q" in data[0]) {
        for (const row of data) this.tickers.set(row.s, tickerRow(row));
      } else if ("p" in data[0] && "r" in data[0]) {
        for (const row of data)
          this.marks.set(row.s, {
            symbol: row.s,
            markPrice: row.p,
            lastFundingRate: row.r,
            nextFundingTime: row.T,
          });
      }
      return;
    }
    if (data?.e === "bookTicker") {
      this.books.set(data.s, {
        symbol: data.s,
        bidPrice: data.b,
        askPrice: data.a,
        time: data.E,
      });
      return;
    }
    if (data?.e === "kline" && data.k) {
      const key = `${data.s}:${data.k.i}`;
      const rows = this.klines.get(key);
      if (!rows?.length) return;
      const next = klineRow(data.k);
      const lastOpen = Number(rows.at(-1)[0]);
      const nextOpen = Number(next[0]);
      const intervalMs = this.intervalMs(data.k.i);
      if (nextOpen - lastOpen > intervalMs * 1.5) {
        this.gappedSeries.add(key);
        return;
      }
      if (lastOpen === nextOpen) rows[rows.length - 1] = next;
      else rows.push(next);
      if (rows.length > 500) rows.splice(0, rows.length - 500);
    }
  }

  intervalMs(interval) {
    return { "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000 }[
      interval
    ] || 60_000;
  }

  seriesFresh(key, rows, interval) {
    if (!rows?.length || this.gappedSeries.has(key)) return false;
    const closeTime = Number(rows.at(-1)[6]);
    return closeTime >= this.now() - this.intervalMs(interval) * 2;
  }

  setUniverse(symbols) {
    const nextUniverse = new Set(["BTCUSDT", ...symbols]);
    const nextDynamic = new Set();
    for (const symbol of nextUniverse) {
      const s = symbol.toLowerCase();
      nextDynamic.add(`${s}@kline_15m`);
      nextDynamic.add(`${s}@kline_1h`);
      nextDynamic.add(`${s}@kline_4h`);
      nextDynamic.add(`${s}@bookTicker`);
    }
    const base = new Set(["!ticker@arr", "!markPrice@arr@1s"]);
    const removed = [...this.subscriptions].filter(
      (stream) => !base.has(stream) && !nextDynamic.has(stream),
    );
    const added = [...nextDynamic].filter(
      (stream) => !this.subscriptions.has(stream),
    );
    this.send("UNSUBSCRIBE", removed);
    this.send("SUBSCRIBE", added);
    this.subscriptions = new Set([...base, ...nextDynamic]);
    this.activeUniverse = nextUniverse;
  }

  async waitFor(predicate, timeoutMs = 12_000) {
    const until = this.now() + timeoutMs;
    while (!predicate()) {
      if (this.now() >= until)
        throw new Error("Binance WebSocket canlı veri bekleme süresi doldu.");
      await sleep(100);
    }
  }

  async ttlGet(path, params, ttlMs) {
    const key = cacheKey(path, params);
    const hit = this.ttl.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value;
    const value = await this.rest.get(path, params, { retries: 0 });
    this.ttl.set(key, { at: this.now(), value });
    return value;
  }

  async get(path, params = {}) {
    if (path === "/fapi/v1/ticker/24hr" && !params?.symbol) {
      await this.waitFor(() => this.tickers.size > 20);
      return [...this.tickers.values()];
    }
    if (path === "/fapi/v1/premiumIndex" && params.symbol) {
      await this.waitFor(() => this.marks.has(params.symbol), 4_000).catch(
        () => null,
      );
      return (
        this.marks.get(params.symbol) ||
        this.ttlGet(path, params, 5 * 60_000)
      );
    }
    if (path === "/fapi/v1/ticker/bookTicker" && params.symbol) {
      await this.waitFor(() => this.books.has(params.symbol), 4_000).catch(
        () => null,
      );
      return (
        this.books.get(params.symbol) ||
        this.ttlGet(path, params, 60_000)
      );
    }
    if (path === "/fapi/v1/klines" && params.symbol && params.interval) {
      const key = `${params.symbol}:${params.interval}`;
      const current = this.klines.get(key);
      if (!this.seriesFresh(key, current, params.interval)) {
        const rows = await this.rest.get(path, params, { retries: 0 });
        this.klines.set(key, rows);
        this.gappedSeries.delete(key);
      }
      const rows = this.klines.get(key);
      return rows.slice(-Number(params.limit || rows.length));
    }
    if (path === "/fapi/v1/exchangeInfo")
      return this.ttlGet(path, params, 24 * 60 * 60_000);
    if (
      path === "/futures/data/openInterestHist" ||
      path === "/futures/data/takerlongshortRatio"
    )
      return this.ttlGet(path, params, 15 * 60_000);
    return this.ttlGet(path, params, 60_000);
  }
}

export { BinanceError };
