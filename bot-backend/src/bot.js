import { executeProtectedTrade } from "./execution.js";
import { applyManagementAction } from "./manage.js";
import { evaluatePosition } from "./monitor.js";
import { scanBestCandidate } from "./radar.js";

export class TradingBot {
  constructor({ client, marketClient = client, store, config }) {
    this.client = client;
    this.marketClient = marketClient;
    this.store = store;
    this.config = config;
    this.busy = false;
    this.reconcilePromise = null;
    this.lastScanAttemptAt = 0;
    this.marketCooldownUntil = Number(store.state.marketCooldownUntil || 0);
    this.marketClient.cooldownUntil = this.marketCooldownUntil;
  }

  limitsOkay() {
    const state = this.store.state;
    this.store.rollDay();
    if (state.killSwitch) return [false, state.killReason || "Kill switch açık"];
    if (!state.enabled) return [false, "Bot panelden kapalı"];
    if (state.totalTrades >= this.config.maxTotalTrades)
      return [false, "Toplam 5 işlem sınırına ulaşıldı"];
    if (state.openTrade)
      return [false, "Aynı anda yalnız 1 açık pozisyon"];
    if (state.consecutiveLosses >= this.config.maxConsecutiveLosses)
      return [false, "Peş peşe zarar limiti"];
    if (
      Number(state.daily.realizedPnl || 0) <= -this.config.maxDailyLossUsdt
    ) return [false, "Günlük zarar limiti"];
    return [true, ""];
  }

  async reconcile() {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileOnce();
    try {
      return await this.reconcilePromise;
    } finally {
      this.reconcilePromise = null;
    }
  }

  async reconcileOnce() {
    const trade = this.store.state.openTrade;
    if (!trade || trade.proofLevel === "DRY_RUN") return;
    await this.client.syncTime();
    const position = await this.client.positionRisk(trade.symbol);
    if (Math.abs(Number(position?.positionAmt || 0)) > 0) {
      trade.markPrice = Number(position.markPrice || 0);
      trade.unrealizedPnl = Number(position.unRealizedProfit || 0);
      trade.lastReconciledAt = Date.now();
      try {
        const signal = await evaluatePosition(this.marketClient, trade, position);
        trade.managementSignal = signal;
        if (signal.ok && signal.action !== "HOLD") {
          this.store.event("POSITION_MONITOR", {
            symbol: trade.symbol,
            action: signal.action,
            reason: signal.reason,
            rNow: signal.rNow,
          });
          if (this.config.managementEnabled) {
            try {
              const outcome = await applyManagementAction(this.client, trade, signal);
              if (outcome.acted) {
                this.store.event("MANAGEMENT_ACTION", {
                  symbol: trade.symbol,
                  kind: outcome.kind,
                  newStopPrice: outcome.newStopPrice || null,
                  newTargetPrice: outcome.newTargetPrice || null,
                });
              }
            } catch (actionError) {
              this.store.state.killSwitch = true;
              this.store.state.killReason = `Yönetim aksiyonu başarısız: ${actionError.message}`;
              this.store.state.enabled = false;
              this.store.event("MANAGEMENT_ACTION_FAILED", {
                symbol: trade.symbol,
                message: actionError.message,
                emergency: actionError.emergency || null,
              });
            }
          }
        }
      } catch (monitorError) {
        trade.managementSignal = {
          ok: false,
          action: "HOLD",
          reason: `İzleme hatası: ${monitorError.message}`,
          evaluatedAt: Date.now(),
        };
      }
      await this.store.save();
      return;
    }
    const income = await this.client.incomeHistory({
      symbol: trade.symbol,
      startTime: trade.createdAt,
    });
    const realizedPnl = (Array.isArray(income) ? income : []).reduce(
      (sum, row) => sum + Number(row.income || 0),
      0,
    );
    await this.client.cancelAll(trade.symbol).catch(() => null);
    this.store.state.daily.realizedPnl += realizedPnl;
    this.store.state.consecutiveLosses =
      realizedPnl < 0 ? this.store.state.consecutiveLosses + 1 : 0;
    this.store.event("TRADE_CLOSED", {
      symbol: trade.symbol,
      realizedPnl,
      entryOrderId: trade.entryOrderId,
      stopOrderId: trade.stopOrderId,
    });
    this.store.state.openTrade = null;
    if (
      this.store.state.consecutiveLosses >= this.config.maxConsecutiveLosses
    ) {
      this.store.state.killSwitch = true;
      this.store.state.killReason = "Peş peşe 2 zarar";
      this.store.state.enabled = false;
    }
    if (
      this.store.state.daily.realizedPnl <= -this.config.maxDailyLossUsdt
    ) {
      this.store.state.killSwitch = true;
      this.store.state.killReason = "Günlük zarar limiti";
      this.store.state.enabled = false;
    }
    await this.store.save();
  }

  async cycle({ forceScan = false } = {}) {
    if (this.busy) return { skipped: true, reason: "Cycle zaten çalışıyor" };
    const now = Date.now();
    if (now < this.marketCooldownUntil)
      return {
        skipped: true,
        reason: `Binance public veri bekleme süresi: ${new Date(
          this.marketCooldownUntil,
        ).toLocaleString("tr-TR")}`,
      };
    if (
      this.lastScanAttemptAt &&
      now - this.lastScanAttemptAt < this.config.scanIntervalMs
    )
      return {
        skipped: true,
        reason: "Yeni tarama en fazla 15 dakikada bir çalıştırılabilir.",
      };
    this.busy = true;
    this.lastScanAttemptAt = now;
    try {
      await this.reconcile();
      const [allowed, reason] = this.limitsOkay();
      if (!allowed && !forceScan) return { skipped: true, reason };

      const candidate = await scanBestCandidate(this.marketClient);
      this.store.state.lastScanAt = Date.now();
      this.store.state.lastCandidate = candidate;
      this.store.state.lastError = "";
      this.store.event("SCAN_COMPLETED", {
        candidate: candidate
          ? { symbol: candidate.symbol, side: candidate.side, score: candidate.score }
          : null,
      });
      await this.store.save();
      if (!candidate) return { candidate: null, executed: false };

      if (!allowed)
        return { candidate, executed: false, reason };

      const trade = await executeProtectedTrade(
        this.client,
        candidate,
        this.config,
        async (progress) => {
          this.store.state.openTrade = progress;
          this.store.event("EXECUTION_PROGRESS", {
            symbol: progress.symbol,
            proofLevel: progress.proofLevel,
            entryOrderId: progress.entryOrderId,
            stopOrderId: progress.stopOrderId,
          });
          await this.store.save();
        },
      );
      this.store.state.openTrade = trade.proofLevel === "DRY_RUN" ? null : trade;
      if (trade.proofLevel !== "DRY_RUN")
        this.store.state.totalTrades++;
      this.store.event("TRADE_OPENED", {
        symbol: trade.symbol,
        side: trade.side,
        proofLevel: trade.proofLevel,
        entryOrderId: trade.entryOrderId,
        stopOrderId: trade.stopOrderId,
      });
      await this.store.save();
      return { candidate, trade, executed: trade.proofLevel !== "DRY_RUN" };
    } catch (error) {
      if (error.status === 418 || error.code === -1003) {
        const timestamp = String(error.message).match(/\b\d{13}\b/)?.[0];
        this.marketCooldownUntil = timestamp
          ? Number(timestamp)
          : Date.now() + 60 * 60 * 1000;
        this.marketClient.cooldownUntil = this.marketCooldownUntil;
        this.store.state.marketCooldownUntil = this.marketCooldownUntil;
        this.store.state.enabled = false;
        this.store.event("MARKET_RATE_LIMIT_CIRCUIT_OPEN", {
          cooldownUntil: this.marketCooldownUntil,
        });
      }
      this.store.state.lastError = error.message;
      this.store.event("CYCLE_ERROR", {
        message: error.message,
        emergency: error.emergency || null,
      });
      if (error.emergency && !error.emergency.closed) {
        this.store.state.killSwitch = true;
        this.store.state.killReason = "ACİL KAPATMA BAŞARISIZ";
        this.store.state.enabled = false;
      }
      await this.store.save();
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async setEnabled(enabled) {
    if (enabled && this.store.state.killSwitch)
      throw new Error("Kill switch açıkken bot başlatılamaz.");
    this.store.state.enabled = Boolean(enabled);
    this.store.event(enabled ? "BOT_ENABLED" : "BOT_DISABLED");
    await this.store.save();
    return this.store.state.enabled;
  }

  async kill(reason = "Kullanıcı acil durdurdu") {
    this.store.state.enabled = false;
    this.store.state.killSwitch = true;
    this.store.state.killReason = reason;
    this.store.event("KILL_SWITCH", { reason });
    await this.store.save();
  }
}
