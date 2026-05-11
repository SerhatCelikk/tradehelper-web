'use client';

import type { Database, SqlJsStatic } from 'sql.js';
import { openDB, type IDBPDatabase } from 'idb';
import type { Alert, BacktestResult, Strategy } from './types';

/**
 * Browser SQLite via sql.js. The compiled WASM is hosted on the official CDN
 * (sql.js.org); cached by the browser after the first load.
 *
 * For full offline support you can copy `sql-wasm.wasm` into /public and
 * change `locateFile` to `/sql-wasm.wasm`.
 */

const IDB_NAME = 'tradehelper';
const IDB_STORE = 'sqlite';
const IDB_KEY = 'database';
const SQLJS_CDN_VERSION = '1.11.0';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  indicator TEXT NOT NULL,
  operator TEXT NOT NULL,
  value REAL NOT NULL,
  message TEXT,
  enabled INTEGER DEFAULT 1,
  last_triggered TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  indicators TEXT NOT NULL,
  buy_conditions TEXT NOT NULL,
  sell_conditions TEXT NOT NULL,
  logic TEXT DEFAULT 'AND',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS watchlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,
  added_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS backtest_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  initial_capital REAL NOT NULL,
  final_capital REAL NOT NULL,
  total_return REAL NOT NULL,
  win_rate REAL,
  num_trades INTEGER,
  max_drawdown REAL,
  sharpe_ratio REAL,
  trades TEXT,
  equity TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol);
CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(enabled);
`;

class SQLiteDB {
  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;
  private initPromise: Promise<void> | null = null;
  private idb: IDBPDatabase | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.bootstrap();
    return this.initPromise;
  }

  private async openIdb(): Promise<IDBPDatabase> {
    if (this.idb) return this.idb;
    this.idb = await openDB(IDB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(IDB_STORE)) {
          d.createObjectStore(IDB_STORE);
        }
      },
    });
    return this.idb;
  }

  private async bootstrap() {
    if (typeof window === 'undefined') {
      throw new Error('SQLite is browser-only.');
    }

    // Dynamic import keeps sql.js out of the SSR bundle.
    const initSqlJs = (await import('sql.js')).default;
    this.SQL = await initSqlJs({
      locateFile: (file: string) =>
        `https://cdnjs.cloudflare.com/ajax/libs/sql.js/${SQLJS_CDN_VERSION}/${file}`,
    });

    const idb = await this.openIdb();
    const saved: ArrayBuffer | undefined = await idb.get(IDB_STORE, IDB_KEY);

    if (saved && saved.byteLength > 0) {
      try {
        this.db = new this.SQL.Database(new Uint8Array(saved));
      } catch (err) {
        console.warn('Failed to open saved DB, recreating:', err);
        this.db = new this.SQL.Database();
      }
    } else {
      this.db = new this.SQL.Database();
    }

    this.db.exec(SCHEMA);
    await this.persist();
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.');
    }
    return this.db;
  }

  /** Debounced persistence to IndexedDB. */
  private schedulePersist() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.persist().catch((err) => {
        console.warn('Failed to persist database:', err);
      });
    }, 500);
  }

  private async persist() {
    if (!this.db) return;
    const data = this.db.export();
    const idb = await this.openIdb();
    // Clone into a plain ArrayBuffer to avoid storing detached Uint8Arrays.
    const buffer = data.buffer.slice(0);
    await idb.put(IDB_STORE, buffer, IDB_KEY);
  }

  /* ------------------------------- Helpers ------------------------------- */

  query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): T[] {
    const db = this.requireDb();
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params as never);
      const out: T[] = [];
      while (stmt.step()) {
        out.push(stmt.getAsObject() as unknown as T);
      }
      return out;
    } finally {
      stmt.free();
    }
  }

  run(sql: string, params: unknown[] = []) {
    const db = this.requireDb();
    db.run(sql, params as never);
    this.schedulePersist();
  }

  /** Returns the auto-increment row id of the last INSERT. */
  insertReturningId(sql: string, params: unknown[] = []): number {
    const db = this.requireDb();
    db.run(sql, params as never);
    const res = db.exec('SELECT last_insert_rowid() AS id');
    this.schedulePersist();
    if (res.length && res[0].values.length) {
      return Number(res[0].values[0][0]);
    }
    return 0;
  }

  /* -------------------------------- Alerts ------------------------------- */

  async getAlerts(): Promise<Alert[]> {
    const rows = this.query<Record<string, unknown>>(
      'SELECT * FROM alerts ORDER BY created_at DESC',
    );
    return rows.map(rowToAlert);
  }

  async createAlert(input: Omit<Alert, 'id' | 'createdAt' | 'lastTriggered'>): Promise<Alert> {
    const id = this.insertReturningId(
      `INSERT INTO alerts (symbol, indicator, operator, value, message, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.symbol,
        input.indicator,
        input.operator,
        input.value,
        input.message ?? '',
        input.enabled ? 1 : 0,
      ],
    );
    const row = this.query<Record<string, unknown>>(
      'SELECT * FROM alerts WHERE id = ?',
      [id],
    )[0];
    return rowToAlert(row);
  }

  async updateAlert(alert: Alert) {
    this.run(
      `UPDATE alerts
         SET symbol = ?, indicator = ?, operator = ?, value = ?, message = ?, enabled = ?
       WHERE id = ?`,
      [
        alert.symbol,
        alert.indicator,
        alert.operator,
        alert.value,
        alert.message,
        alert.enabled ? 1 : 0,
        alert.id,
      ],
    );
  }

  async setAlertTriggered(id: number, ts: string) {
    this.run('UPDATE alerts SET last_triggered = ? WHERE id = ?', [ts, id]);
  }

  async deleteAlert(id: number) {
    this.run('DELETE FROM alerts WHERE id = ?', [id]);
  }

  /* ----------------------------- Strategies ------------------------------ */

  async getStrategies(): Promise<Strategy[]> {
    const rows = this.query<Record<string, unknown>>(
      'SELECT * FROM strategies ORDER BY created_at DESC',
    );
    return rows.map(rowToStrategy);
  }

  async saveStrategy(s: Strategy): Promise<number> {
    const id = this.insertReturningId(
      `INSERT INTO strategies (name, description, indicators, buy_conditions, sell_conditions, logic)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        s.name,
        s.description ?? '',
        JSON.stringify(s.indicators),
        JSON.stringify(s.buyConditions),
        JSON.stringify(s.sellConditions),
        s.logic,
      ],
    );
    return id;
  }

  async deleteStrategy(id: number) {
    this.run('DELETE FROM strategies WHERE id = ?', [id]);
  }

  /* --------------------------- Backtest history -------------------------- */

  async saveBacktestResult(r: BacktestResult, strategyId?: number) {
    this.run(
      `INSERT INTO backtest_results (
        strategy_id, symbol, timeframe, start_time, end_time,
        initial_capital, final_capital, total_return,
        win_rate, num_trades, max_drawdown, sharpe_ratio, trades, equity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        strategyId ?? null,
        r.symbol,
        r.timeframe,
        r.startTime,
        r.endTime,
        r.performance.initialCapital,
        r.performance.finalCapital,
        r.performance.totalReturn,
        r.performance.winRate,
        r.performance.numberOfTrades,
        r.performance.maxDrawdownPercent,
        r.performance.sharpeRatio,
        JSON.stringify(r.trades),
        JSON.stringify(r.equity),
      ],
    );
  }

  /* ----------------------------- Maintenance ----------------------------- */

  async exportBlob(): Promise<Blob> {
    const data = this.requireDb().export();
    return new Blob([data], { type: 'application/x-sqlite3' });
  }

  async importFromFile(file: File) {
    if (!this.SQL) await this.init();
    const buf = await file.arrayBuffer();
    this.db = new this.SQL!.Database(new Uint8Array(buf));
    this.db.exec(SCHEMA);
    await this.persist();
  }

  async clearAll() {
    const db = this.requireDb();
    db.exec(`
      DELETE FROM alerts;
      DELETE FROM strategies;
      DELETE FROM watchlists;
      DELETE FROM backtest_results;
    `);
    await this.persist();
  }

  async size(): Promise<number> {
    if (!this.db) return 0;
    return this.db.export().byteLength;
  }
}

export const database = new SQLiteDB();

/* ------------------------------ Row mappers ------------------------------ */

function rowToAlert(r: Record<string, unknown>): Alert {
  return {
    id: Number(r.id),
    symbol: String(r.symbol),
    indicator: String(r.indicator) as Alert['indicator'],
    operator: String(r.operator) as Alert['operator'],
    value: Number(r.value),
    message: String(r.message ?? ''),
    enabled: Number(r.enabled) === 1,
    lastTriggered: r.last_triggered ? String(r.last_triggered) : null,
    createdAt: String(r.created_at ?? ''),
  };
}

function rowToStrategy(r: Record<string, unknown>): Strategy {
  return {
    id: Number(r.id),
    name: String(r.name),
    description: r.description ? String(r.description) : '',
    indicators: safeParseJson(String(r.indicators), []) as Strategy['indicators'],
    buyConditions: safeParseJson(String(r.buy_conditions), []) as Strategy['buyConditions'],
    sellConditions: safeParseJson(String(r.sell_conditions), []) as Strategy['sellConditions'],
    logic: (String(r.logic) as Strategy['logic']) || 'AND',
  };
}

function safeParseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
