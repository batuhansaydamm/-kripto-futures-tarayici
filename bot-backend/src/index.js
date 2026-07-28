import { BinanceClient } from "./binance.js";
import { TradingBot } from "./bot.js";
import { config, validateConfig } from "./config.js";
import { startServer } from "./server.js";
import { StateStore } from "./state.js";

validateConfig();
const store = new StateStore(config.statePath);
await store.load();
const client = new BinanceClient({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  apiSecret: config.apiSecret,
});
const marketClient = new BinanceClient({
  baseUrl: config.marketDataBaseUrl,
});
const bot = new TradingBot({ client, marketClient, store, config });
startServer({ bot, store, config });

console.log(
  JSON.stringify({
    event: "BOOT",
    engine: "V13.2_STRUCTURE_EXECUTION",
    dryRun: config.dryRun,
    endpoint: config.baseUrl,
    marketDataEndpoint: config.marketDataBaseUrl,
    port: config.port,
    limits: {
      marginUsdt: config.marginUsdt,
      leverage: config.leverage,
      maxTotalTrades: config.maxTotalTrades,
      maxOpenPositions: config.maxOpenPositions,
    },
  }),
);

const cycle = async () => {
  if (!store.state.enabled) return;
  try {
    const result = await bot.cycle();
    console.log(
      JSON.stringify({
        event: "CYCLE",
        at: new Date().toISOString(),
        result,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "CYCLE_ERROR",
        at: new Date().toISOString(),
        message: error.message,
        emergency: error.emergency || null,
      }),
    );
  }
};

setInterval(cycle, config.scanIntervalMs).unref();
setInterval(() => bot.reconcile().catch(() => {}), 60_000).unref();
setTimeout(cycle, 2_000).unref();
