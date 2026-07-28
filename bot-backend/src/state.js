import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const fresh = () => ({
  version: 1,
  enabled: false,
  killSwitch: false,
  killReason: "",
  totalTrades: 0,
  consecutiveLosses: 0,
  daily: { date: new Date().toISOString().slice(0, 10), realizedPnl: 0 },
  openTrade: null,
  lastScanAt: 0,
  lastCandidate: null,
  lastError: "",
  marketCooldownUntil: 0,
  events: [],
});

export class StateStore {
  constructor(path) {
    this.path = path;
    this.state = fresh();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      this.state = { ...fresh(), ...JSON.parse(await readFile(this.path, "utf8")) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }
    this.rollDay();
    return this.state;
  }

  rollDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.daily?.date !== today)
      this.state.daily = { date: today, realizedPnl: 0 };
  }

  event(type, detail = {}) {
    this.state.events.push({ at: Date.now(), type, ...detail });
    this.state.events = this.state.events.slice(-300);
  }

  async save() {
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state, null, 2));
      await rename(tmp, this.path);
    });
    return this.queue;
  }
}
