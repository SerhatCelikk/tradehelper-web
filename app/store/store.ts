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

export interface SymbolStat {
  price: number;
  change: number;
  volume: number;
}

export type MarketCategory = 'favorites' | 'crypto' | 'stocks' | 'commodities';

interface AppState {
  // Symbol & timeframe
  selectedSymbol: string;
  timeframe: Timeframe;
  watchlist: string[];

  // Universe: all USDT trading pairs from Binance
  allSymbols: string[];
  // Curated Yahoo-Finance backed universes
  stockSymbols: string[];
  commoditySymbols: string[];
  // Unified price/change map keyed by ticker, regardless of asset class
  symbolStats: Record<string, SymbolStat>;
  /**
   * Per-symbol price-display precision. For Binance pairs this is derived
   * from the exchange's `PRICE_FILTER.tickSize`; for Yahoo-backed tickers we
   * fall back to a sensible per-asset-class default. Missing entries mean
   * "use the magnitude-based fallback in `formatPrice`".
   */
  symbolPrecisions: Record<string, number>;
  isSymbolsLoading: boolean;
  symbolsError: string | null;

  // UI: which market-category sections are collapsed in the side panel
  collapsedSections: Record<MarketCategory, boolean>;

  // Single indicator to isolate on the chart — when set, its buy/sell signals
  // are the only ones drawn, and the in-position vs flat-position zones are
  // shaded behind the candles.
  focusedIndicatorId: string | null;

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

  /**
   * User-composed strategy: a list of indicators (each contributing its own
   * default buy/sell signal) plus a global AND/OR connective. Driven by the
   * "My Strategy" tab below the chart — the user adds indicators with a +
   * button on each performance card, picks ALL vs ANY, then hits Run.
   */
  customStrategy: {
    indicators: IndicatorConfig[];
    logic: 'AND' | 'OR';
    /**
     * When true, the composite strategy's BUY/SELL signal circles render on
     * the chart alongside the enabled-indicator signals. Independent of
     * `focused` — you can have signals without zones or zones without
     * signals.
     */
    showOnChart: boolean;
    /**
     * When true, the strategy takes over zone shading (green long / red
     * short) on the chart, overriding any focused indicator. Mutually
     * exclusive with `focusedIndicatorId` — toggling this on clears that
     * and vice versa.
     */
    focused: boolean;
  };

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
  toggleFavorite: (s: string) => void;
  setWatchlist: (list: string[]) => void;

  setAllSymbols: (s: string[]) => void;
  setStockSymbols: (s: string[]) => void;
  setCommoditySymbols: (s: string[]) => void;
  setSymbolStats: (s: Record<string, SymbolStat>) => void;
  mergeSymbolStats: (s: Record<string, SymbolStat>) => void;
  setSymbolPrecisions: (s: Record<string, number>) => void;
  mergeSymbolPrecisions: (s: Record<string, number>) => void;
  setSymbolsLoading: (b: boolean) => void;
  setSymbolsError: (e: string | null) => void;
  toggleSection: (key: MarketCategory) => void;
  setFocusedIndicator: (id: string | null) => void;

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
  /**
   * Apply an optimizer result. If an indicator of the same type already
   * exists, the first one is overwritten with the new params + timeframe and
   * left enabled. Otherwise a fresh config is appended. Returns the id of
   * the updated/added indicator so the caller can focus it on the chart.
   */
  replaceOrAddIndicator: (
    type: IndicatorConfig['type'],
    params: IndicatorConfig['params'],
    timeframe: IndicatorConfig['timeframe'],
  ) => string;

  /** Add (or replace) an indicator slot in the user's custom strategy. */
  addToCustomStrategy: (cfg: IndicatorConfig) => void;
  removeFromCustomStrategy: (type: IndicatorConfig['type']) => void;
  setCustomStrategyLogic: (logic: 'AND' | 'OR') => void;
  setCustomStrategyShowOnChart: (show: boolean) => void;
  setCustomStrategyFocused: (focused: boolean) => void;
  clearCustomStrategy: () => void;

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
  collapsedSections: 'th_sections_collapsed',
  customStrategy: 'th_custom_strategy',
};

const DEFAULT_COLLAPSED: Record<MarketCategory, boolean> = {
  favorites: false,
  crypto: false,
  stocks: true,
  commodities: true,
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

  allSymbols: [],
  stockSymbols: [],
  commoditySymbols: [],
  symbolStats: {},
  symbolPrecisions: {},
  isSymbolsLoading: false,
  symbolsError: null,

  collapsedSections: { ...DEFAULT_COLLAPSED },
  focusedIndicatorId: null,

  candleData: [],
  lastPrice: null,
  priceChange24h: null,
  ticker: null,
  isStreamConnected: false,
  streamError: null,
  isLoadingHistory: false,

  indicators: DEFAULT_INDICATORS,

  customStrategy: {
    indicators: [],
    logic: 'AND' as const,
    showOnChart: false,
    focused: false,
  },

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
  toggleFavorite: (s) => {
    const current = get().watchlist;
    const wl = current.includes(s)
      ? current.filter((x) => x !== s)
      : Array.from(new Set([...current, s]));
    set({ watchlist: wl });
    savePersisted(persistKeys.watchlist, wl);
  },
  setWatchlist: (list) => {
    set({ watchlist: list });
    savePersisted(persistKeys.watchlist, list);
  },

  setAllSymbols: (s) => set({ allSymbols: s }),
  setStockSymbols: (s) => set({ stockSymbols: s }),
  setCommoditySymbols: (s) => set({ commoditySymbols: s }),
  setSymbolStats: (s) => set({ symbolStats: s }),
  mergeSymbolStats: (s) =>
    set({ symbolStats: { ...get().symbolStats, ...s } }),
  setSymbolPrecisions: (s) => set({ symbolPrecisions: s }),
  mergeSymbolPrecisions: (s) =>
    set({ symbolPrecisions: { ...get().symbolPrecisions, ...s } }),
  setSymbolsLoading: (b) => set({ isSymbolsLoading: b }),
  setSymbolsError: (e) => set({ symbolsError: e }),
  toggleSection: (key) => {
    const next = {
      ...get().collapsedSections,
      [key]: !get().collapsedSections[key],
    };
    set({ collapsedSections: next });
    savePersisted(persistKeys.collapsedSections, next);
  },
  setFocusedIndicator: (id) => {
    // Focusing an indicator displaces strategy focus (and vice versa in
    // `setCustomStrategyFocused`).
    if (id !== null && get().customStrategy.focused) {
      const next = { ...get().customStrategy, focused: false };
      set({ focusedIndicatorId: id, customStrategy: next });
      savePersisted(persistKeys.customStrategy, next);
    } else {
      set({ focusedIndicatorId: id });
    }
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
  replaceOrAddIndicator: (type, params, timeframe) => {
    const current = get().indicators;
    const idx = current.findIndex((i) => i.type === type);
    if (idx >= 0) {
      const existing = current[idx];
      const next: IndicatorConfig = {
        ...existing,
        params: { ...params },
        timeframe,
        enabled: true,
      };
      const indicators = current.slice();
      indicators[idx] = next;
      set({ indicators });
      savePersisted(persistKeys.indicators, indicators);
      return next.id;
    }
    const def = defaultConfigForType(type);
    const cfg: IndicatorConfig = {
      ...def,
      id: `${type.toLowerCase()}-opt-${Date.now().toString(36)}`,
      params: { ...params },
      timeframe,
      enabled: true,
    };
    const indicators = [...current, cfg];
    set({ indicators });
    savePersisted(persistKeys.indicators, indicators);
    return cfg.id;
  },

  addToCustomStrategy: (cfg) => {
    // One slot per indicator type — re-adding RSI with different params
    // overwrites the previous slot rather than stacking two RSI rows.
    const current = get().customStrategy;
    const filtered = current.indicators.filter((i) => i.type !== cfg.type);
    const snapshot: IndicatorConfig = {
      ...cfg,
      enabled: true,
      params: { ...cfg.params },
    };
    const next = { ...current, indicators: [...filtered, snapshot] };
    set({ customStrategy: next });
    savePersisted(persistKeys.customStrategy, next);
  },
  removeFromCustomStrategy: (type) => {
    const current = get().customStrategy;
    const next = {
      ...current,
      indicators: current.indicators.filter((i) => i.type !== type),
    };
    set({ customStrategy: next });
    savePersisted(persistKeys.customStrategy, next);
  },
  setCustomStrategyLogic: (logic) => {
    const next = { ...get().customStrategy, logic };
    set({ customStrategy: next });
    savePersisted(persistKeys.customStrategy, next);
  },
  setCustomStrategyShowOnChart: (showOnChart) => {
    const next = { ...get().customStrategy, showOnChart };
    set({ customStrategy: next });
    savePersisted(persistKeys.customStrategy, next);
  },
  setCustomStrategyFocused: (focused) => {
    const next = { ...get().customStrategy, focused };
    // Focusing the strategy displaces any indicator focus — only one thing
    // can own the chart's zone shading at a time, and trying to coexist
    // would just produce noise.
    if (focused) {
      set({ customStrategy: next, focusedIndicatorId: null });
    } else {
      set({ customStrategy: next });
    }
    savePersisted(persistKeys.customStrategy, next);
  },
  clearCustomStrategy: () => {
    const next = {
      indicators: [],
      logic: 'AND' as const,
      showOnChart: false,
      focused: false,
    };
    // Drop the last backtest result too — it was computed for the now-
    // cleared strategy and would otherwise leave orphaned trade markers
    // floating on the chart.
    set({ customStrategy: next, lastBacktest: null });
    savePersisted(persistKeys.customStrategy, next);
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
  const collapsed = loadPersisted<Partial<Record<MarketCategory, boolean>> | null>(
    persistKeys.collapsedSections,
    null,
  );

  const state = useAppStore.getState();
  if (symbol) state.setSelectedSymbol(symbol);
  if (timeframe) state.setTimeframe(timeframe);
  if (watchlist && watchlist.length) state.setWatchlist(watchlist);
  if (indicators && indicators.length) {
    // setIndicators also re-persists, so old/partial saves get rewritten clean.
    state.setIndicators(indicators);
  }
  if (collapsed && typeof collapsed === 'object') {
    useAppStore.setState({
      collapsedSections: { ...DEFAULT_COLLAPSED, ...collapsed },
    });
  }

  const customStrategyRaw = loadPersisted<unknown>(persistKeys.customStrategy, null);
  if (
    customStrategyRaw &&
    typeof customStrategyRaw === 'object' &&
    Array.isArray((customStrategyRaw as { indicators?: unknown }).indicators)
  ) {
    const cs = customStrategyRaw as {
      indicators: unknown[];
      logic?: 'AND' | 'OR';
    };
    const migrated: IndicatorConfig[] = [];
    for (const raw of cs.indicators) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Partial<IndicatorConfig> & { type?: string };
      if (!r.type) continue;
      const def = defaultConfigForType(r.type as IndicatorConfig['type']);
      migrated.push({
        ...def,
        ...r,
        id: r.id ?? def.id,
        type: (r.type as IndicatorConfig['type']) ?? def.type,
        enabled: true,
        color: r.color ?? def.color,
        params: { ...def.params, ...(r.params ?? {}) },
        timeframe: r.timeframe ?? def.timeframe,
      });
    }
    const csTyped = cs as typeof cs & {
      showOnChart?: boolean;
      focused?: boolean;
    };
    useAppStore.setState({
      customStrategy: {
        indicators: migrated,
        logic: cs.logic === 'OR' ? 'OR' : 'AND',
        showOnChart: csTyped.showOnChart === true,
        focused: csTyped.focused === true,
      },
    });
  }
}
