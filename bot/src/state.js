import fs from 'node:fs';
import path from 'node:path';

const initialState = {
  totalTrades: 0,
  openPosition: null,
  consecutiveLosses: 0,
  apiErrors: 0,
  daily: { date: new Date().toISOString().slice(0, 10), realizedPnl: 0 },
  killSwitch: false,
  events: []
};

export class StateStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.state = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.filePath)) return structuredClone(initialState);
    try {
      return { ...structuredClone(initialState), ...JSON.parse(fs.readFileSync(this.filePath, 'utf8')) };
    } catch (error) {
      throw new Error(`State file okunamadı: ${error.message}`);
    }
  }

  rolloverDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.daily?.date !== today) {
      this.state.daily = { date: today, realizedPnl: 0 };
      this.state.consecutiveLosses = 0;
      this.save();
    }
  }

  event(type, payload = {}) {
    this.state.events.push({ at: new Date().toISOString(), type, ...payload });
    this.state.events = this.state.events.slice(-500);
    this.save();
  }

  save() {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
