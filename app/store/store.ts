'use client';

import { create } from 'zustand';
import type {
  Alert,
  BacktestResult,
  Candle,
  IndicatorConfig,
  Strategy,
  Ticker,
  Timeframe,
} from '../lib/types';

export const POPULAR_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'DOTUSDT',
  'MATICUSDT',
  'TRXUSDT',
  'LTCUSDT',
  'NEARUSDT',
  'ATOMUSDT',
];

export const DEFAULT_INDICATORS: IndicatorConfig[] = [
  {
    id: 'rsi-default',
    type: 'RSI',
    enabled: false,
    params: { period: 14, oversold: 30, overbought: 70 },
    timeframe: '4h',
    color: '#2962FF',
  },
  {
    id: 'macd-default',
    type: 'MACD',
    enabled: false,
    params: {
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      macdMode: 'signal_cross',
    },
    timeframe: '4h',
    color: '#26A69A',
  },
  {
    id: 'bbands-default',
    type: 'BBANDS',
    enabled: false,
    params: { period: 20, stdDev: 2, bbandsMode: 'mean_reversion' },
    timeframe: '4h',
    color: '#9C27B0',
  },
  {
    id: 'sma-default',
    type: 'SMA',
    enabled: false,
    params: { period: 20, maMode: 'price_cross', trendLookback: 5 },
    timeframe: '4h',
    color: '#FF9800',
  },
  {
    id: 'ema-default',
    type: 'EMA',
    enabled: false,
    params: { period: 50, maMode: 'price_cross', trendLookback: 5 },
    timeframe: '4h',
    color: '#03A9F4',
  },
];

export function defaultConfigForType(type: IndicatorConfig['type']): IndicatorConfig {
  const base = DEFAULT_INDICATORS.find((i) => i.type === type);
  if (!base) {
    return {
      id: `${type.toLowerCase()}-default`,
      type,
      enabled: false,
      params: {},
      timeframe: '4h',
      color: '#2962FF',
    };
  }
  // Return a fresh copy
  return JSON.parse(JSON.stringify(base)) as IndicatorConfig;
}

interface AppState {
  // Symbol & timeframe
  selectedSymbol: string;
  timeframe: Timeframe;
  watchlist: string[];

  // Market data
  candleData: Candle[];
  lastPrice: number | null;
  priceChange24h: number | null;
  ticker: Ticker | null;
  isStreamConnected: boolean;
  streamError: string | null;
  isLoadingHistory: boolean;

  // Indicators
  indicators: IndicatorConfig[];

  // Backtest
  lastBacktest: BacktestResult | null;
  isBacktestRunning: boolean;
  showBacktestPanel: boolean;

  // Alerts
  alerts: Alert[];
  unreadNotifications: number;

  // Strategies (saved)
  strategies: Strategy[];

  // UI
  isDatabaseReady: boolean;
  isMobileMenuOpen: boolean;
  notificationPermission: NotificationPermission | 'default';

  // Actions
  setSelectedSymbol: (s: string) => void;
  setTimeframe: (t: Timeframe) => void;
  addToWatchlist: (s: string) => void;
  removeFromWatchlist: (s: string) => void;
  setWatchlist: (list: string[]) => void;

  setCandleData: (c: Candle[]) => void;
  appendCandle: (c: Candle) => void;
  setLastPrice: (p: number) => void;
  setTicker: (t: Ticker | null) => void;
  setStreamConnected: (b: boolean) => void;
  setStreamError: (e: string | null) => void;
  setLoadingHistory: (b: boolean) => void;

  setIndicators: (i: IndicatorConfig[]) => void;
  toggleIndicator: (id: string) => void;
  updateIndicatorParams: (id: string, params: IndicatorConfig['params']) => void;
  addIndicator: (cfg: IndicatorConfig) => void;
  removeIndicator: (id: string) => void;

  setLastBacktest: (r: BacktestResult | null) => void;
  setBacktestRunning: (b: boolean) => void;
  setShowBacktestPanel: (b: boolean) => void;

  setAlerts: (a: Alert[]) => void;
  addAlertLocal: (a: Alert) => void;
  removeAlertLocal: (id: number) => void;
  updateAlertLocal: (a: Alert) => void;
  incrementUnread: () => void;
  resetUnread: () => void;

  setStrategies: (s: Strategy[]) => void;

  setDatabaseReady: (b: boolean) => void;
  setMobileMenuOpen: (b: boolean) => void;
  setNotificationPermission: (p: NotificationPermission | 'default') => void;
}

const persistKeys = {
  watchlist: 'th_watchlist',
  symbol: 'th_symbol',
  timeframe: 'th_timeframe',
  indicators: 'th_indicators',
};

function loadPersisted<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function savePersisted(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  selectedSymbol: 'BTCUSDT',
  timeframe: '1h',
  watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],

  candleData: [],
  lastPrice: null,
  priceChange24h: null,
  ticker: null,
  isStreamConnected: false,
  streamError: null,
  isLoadingHistory: false,

  indicators: DEFAULT_INDICATORS,

  lastBacktest: null,
  isBacktestRunning: false,
  showBacktestPanel: false,

  alerts: [],
  unreadNotifications: 0,

  strategies: [],

  isDatabaseReady: false,
  isMobileMenuOpen: false,
  notificationPermission: 'default',

  setSelectedSymbol: (s) => {
    set({ selectedSymbol: s });
    savePersisted(persistKeys.symbol, s);
  },
  setTimeframe: (t) => {
    set({ timeframe: t });
    savePersisted(persistKeys.timeframe, t);
  },
  addToWatchlist: (s) => {
    const wl = Array.from(new Set([...get().watchlist, s]));
    set({ watchlist: wl });
    savePersisted(persistKeys.watchlist, wl);
  },
  removeFromWatchlist: (s) => {
    const wl = get().watchlist.filter((x) => x !== s);
    set({ watchlist: wl });
    savePersisted(persistKeys.watchlist, wl);
  },
  setWatchlist: (list) => {
    set({ watchlist: list });
    savePersisted(persistKeys.watchlist, list);
  },

  setCandleData: (c) => set({ candleData: c }),
  appendCandle: (c) => {
    const arr = [...get().candleData];
    if (arr.length === 0) {
      arr.push(c);
    } else {
      const last = arr[arr.length - 1];
      if (last.time === c.time) {
        arr[arr.length - 1] = c;
      } else if (c.time > last.time) {
        arr.push(c);
        if (arr.length > 1000) arr.shift();
      }
    }
    set({ candleData: arr, lastPrice: c.close });
  },
  setLastPrice: (p) => set({ lastPrice: p }),
  setTicker: (t) =>
    set({
      ticker: t,
      priceChange24h: t?.priceChangePercent ?? null,
    }),
  setStreamConnected: (b) => set({ isStreamConnected: b }),
  setStreamError: (e) => set({ streamError: e }),
  setLoadingHistory: (b) => set({ isLoadingHistory: b }),

  setIndicators: (i) => {
    set({ indicators: i });
    savePersisted(persistKeys.indicators, i);
  },
  toggleIndicator: (id) => {
    const indicators = get().indicators.map((ind) =>
      ind.id === id ? { ...ind, enabled: !ind.enabled } : ind,
    );
    set({ indicators });
    savePersisted(persistKeys.indicators, indicators);
  },
  updateIndicatorParams: (id, params) => {
    const indicators = get().indicators.map((ind) =>
      ind.id === id ? { ...ind, params: { ...ind.params, ...params } } : ind,
    );
    set({ indicators });
    savePersisted(persistKeys.indicators, indicators);
  },
  addIndicator: (cfg) => {
    const indicators = [...get().indicators, cfg];
    set({ indicators });
    savePersisted(persistKeys.indicators, indicators);
  },
  removeIndicator: (id) => {
    const indicators = get().indicators.filter((i) => i.id !== id);
    set({ indicators });
    savePersisted(persistKeys.indicators, indicators);
  },

  setLastBacktest: (r) => set({ lastBacktest: r }),
  setBacktestRunning: (b) => set({ isBacktestRunning: b }),
  setShowBacktestPanel: (b) => set({ showBacktestPanel: b }),

  setAlerts: (a) => set({ alerts: a }),
  addAlertLocal: (a) => set({ alerts: [...get().alerts, a] }),
  removeAlertLocal: (id) =>
    set({ alerts: get().alerts.filter((x) => x.id !== id) }),
  updateAlertLocal: (a) =>
    set({ alerts: get().alerts.map((x) => (x.id === a.id ? a : x)) }),
  incrementUnread: () =>
    set({ unreadNotifications: get().unreadNotifications + 1 }),
  resetUnread: () => set({ unreadNotifications: 0 }),

  setStrategies: (s) => set({ strategies: s }),

  setDatabaseReady: (b) => set({ isDatabaseReady: b }),
  setMobileMenuOpen: (b) => set({ isMobileMenuOpen: b }),
  setNotificationPermission: (p) => set({ notificationPermission: p }),
}));

/**
 * Older versions of the app stored indicator configs without a `timeframe`
 * field. Without migration, those values surface as `undefined` in the URL
 * (e.g. `?interval=undefined`) and Binance rejects the request. Fill in any
 * missing fields from the matching default for the type.
 */
function migrateIndicators(saved: unknown): IndicatorConfig[] | null {
  if (!Array.isArray(saved) || saved.length === 0) return null;
  const out: IndicatorConfig[] = [];
  for (const raw of saved) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<IndicatorConfig> & { type?: string };
    if (!r.type) continue;
    const def = defaultConfigForType(r.type as IndicatorConfig['type']);
    out.push({
      ...def,
      ...r,
      id: r.id ?? def.id,
      type: (r.type as IndicatorConfig['type']) ?? def.type,
      enabled: r.enabled ?? false,
      color: r.color ?? def.color,
      params: { ...def.params, ...(r.params ?? {}) },
      timeframe: r.timeframe ?? def.timeframe,
    });
  }
  return out;
}

export function hydrateStoreFromStorage() {
  if (typeof window === 'undefined') return;
  const symbol = loadPersisted<string | null>(persistKeys.symbol, null);
  const timeframe = loadPersisted<Timeframe | null>(
    persistKeys.timeframe,
    null,
  );
  const watchlist = loadPersisted<string[] | null>(persistKeys.watchlist, null);
  const indicatorsRaw = loadPersisted<unknown>(persistKeys.indicators, null);
  const indicators = migrateIndicators(indicatorsRaw);

  const state = useAppStore.getState();
  if (symbol) state.setSelectedSymbol(symbol);
  if (timeframe) state.setTimeframe(timeframe);
  if (watchlist && watchlist.length) state.setWatchlist(watchlist);
  if (indicators && indicators.length) {
    // setIndicators also re-persists, so old/partial saves get rewritten clean.
    state.setIndicators(indicators);
  }
}
