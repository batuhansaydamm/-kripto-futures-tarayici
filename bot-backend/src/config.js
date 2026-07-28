const number = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} geçerli bir sayı değil`);
  return value;
};

const bool = (name, fallback) =>
  String(process.env[name] ?? fallback).toLowerCase() === "true";

export const config = Object.freeze({
  baseUrl:
    process.env.BINANCE_BASE_URL || "https://testnet.binancefuture.com",
  marketDataBaseUrl:
    process.env.MARKET_DATA_BASE_URL || "https://fapi.binance.com",
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  dashboardToken: process.env.DASHBOARD_TOKEN || "",
  dryRun: bool("DRY_RUN", true),
  botEnabled: bool("BOT_ENABLED", false),
  managementEnabled: bool("MANAGEMENT_ENABLED", true),
  port: number("PORT", 3000),
  scanIntervalMs: number("SCAN_INTERVAL_MS", 15 * 60 * 1000),
  marginUsdt: number("MARGIN_USDT", 50),
  leverage: number("LEVERAGE", 10),
  maxTotalTrades: number("MAX_TOTAL_TRADES", 5),
  maxOpenPositions: number("MAX_OPEN_POSITIONS", 1),
  maxConsecutiveLosses: number("MAX_CONSECUTIVE_LOSSES", 2),
  maxDailyLossUsdt: number("MAX_DAILY_LOSS_USDT", 100),
  statePath: process.env.STATE_PATH || "./data/state.json",
});

export function validateConfig() {
  const url = new URL(config.baseUrl);
  if (url.hostname !== "testnet.binancefuture.com") {
    throw new Error(
      "Bu sürüm yalnız Binance Futures Testnet adresinde çalışır; canlı endpoint kilitli.",
    );
  }
  const marketUrl = new URL(config.marketDataBaseUrl);
  if (marketUrl.hostname !== "fapi.binance.com") {
    throw new Error(
      "Piyasa verisi yalnız resmi Binance Futures public endpoint'inden alınabilir.",
    );
  }
  if (config.leverage !== 10)
    throw new Error("İlk test sürümünde leverage tam olarak x10 olmalı.");
  if (config.marginUsdt !== 50)
    throw new Error("İlk test sürümünde marjin tam olarak 50 USDT olmalı.");
  if (config.maxTotalTrades !== 5 || config.maxOpenPositions !== 1)
    throw new Error("Güvenlik sınırı: toplam 5 işlem, eşzamanlı 1 pozisyon.");
  if (!config.dryRun && (!config.apiKey || !config.apiSecret))
    throw new Error("Testnet emir modu için API anahtarı ve secret gerekli.");
  if (!config.dashboardToken || config.dashboardToken.length < 16)
    throw new Error("DASHBOARD_TOKEN en az 16 karakter olmalı.");
}
