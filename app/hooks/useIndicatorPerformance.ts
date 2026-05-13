'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/store';
import {
  getCachedKlines,
  invalidateKlinesCache as invalidateShared,
} from '../lib/klinesCache';
import { runBacktest } from '../lib/backtest';
import { defaultStrategyFor } from '../lib/indicatorStrategies';
import type {
  BacktestResult,
  Candle,
  IndicatorConfig,
  Timeframe,
} from '../lib/types';

const DAY = 86_400_000;

const YEARLY_RANGE_MS = 365 * DAY;

const RANGES = {
  daily: 1 * DAY,
  weekly: 7 * DAY,
  monthly: 30 * DAY,
  yearly: 365 * DAY,
} as const;

const TIMEFRAME_MS_LOCAL: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

/**
 * Fetch enough history so the strategy's long/flat state machine can evolve
 * naturally from far before the displayed range. Otherwise an indicator that
 * bought months ago and never sold would still appear to make "fresh" round
 * trips in the Weekly/Monthly window because the state was artificially
 * reset to flat at the window start — which is what was producing the
 * "Weekly: 4 trades" vs "chart has been green since November" mismatch.
 *
 * We target ~500 candles at the indicator's own timeframe (matches the
 * chart's `limit: 500` fetch) with a floor of 31 days and a ceiling of
 * 730 days (Yahoo's per-interval cap for sub-daily data).
 */
function autoRangeFor(tf: Timeframe): number {
  const tfMs = TIMEFRAME_MS_LOCAL[tf] ?? TIMEFRAME_MS_LOCAL['4h'];
  const target = 500 * tfMs;
  return Math.min(730 * DAY, Math.max(31 * DAY, target));
}

export type RangeKey = keyof typeof RANGES;

export interface PerformanceStat {
  totalReturnPercent: number;
  numberOfTrades: number;
  winRate: number;
  available: boolean;
}

export interface IndicatorPerformance {
  daily?: PerformanceStat;
  weekly?: PerformanceStat;
  monthly?: PerformanceStat;
  yearly?: PerformanceStat;
  candleCount: number;
  startTime: number | null;
  endTime: number | null;
}

/* -------------------------------------------------------------------------- */
/*                              Hook implementation                           */
/* -------------------------------------------------------------------------- */

export interface UseIndicatorPerformanceReturn {
  data: Map<string, IndicatorPerformance>;
  /** Any timeframe currently fetching auto data. */
  globalLoading: boolean;
  /** Reported when ALL active timeframes failed; suitable for a top banner. */
  globalError: string | null;
  /** True iff this indicator's timeframe is currently fetching auto data. */
  isLoadingFor: (ind: IndicatorConfig) => boolean;
  /** Auto-fetch error specific to this indicator's timeframe. */
  errorFor: (ind: IndicatorConfig) => string | null;
  /** Whether this indicator's yearly fetch is currently running. */
  isYearlyLoading: (ind: IndicatorConfig) => boolean;
  /** Yearly-fetch error specific to this indicator's timeframe. */
  yearlyErrorFor: (ind: IndicatorConfig) => string | null;
  runYearly: (indicatorId: string) => Promise<void>;
  retry: () => void;
}

export function useIndicatorPerformance(
  symbol: string,
  indicators: IndicatorConfig[],
): UseIndicatorPerformanceReturn {
  // Live crypto universe — used by the dispatcher to pick Binance vs Yahoo.
  const allSymbols = useAppStore((s) => s.allSymbols);
  const cryptoUniverse = useMemo(() => new Set(allSymbols), [allSymbols]);

  // Auto state (D/W/M)
  const [autoData, setAutoData] = useState<Map<string, IndicatorPerformance>>(
    new Map(),
  );
  const [autoLoadingTfs, setAutoLoadingTfs] = useState<Set<Timeframe>>(
    new Set(),
  );
  const [autoErrors, setAutoErrors] = useState<Map<Timeframe, string>>(
    new Map(),
  );
  const [refreshKey, setRefreshKey] = useState(0);

  // Yearly state (per-timeframe)
  const [yearlyData, setYearlyData] = useState<Map<string, PerformanceStat>>(
    new Map(),
  );
  const [yearlyLoadingTfs, setYearlyLoadingTfs] = useState<Set<Timeframe>>(
    new Set(),
  );
  const [yearlyErrors, setYearlyErrors] = useState<Map<Timeframe, string>>(
    new Map(),
  );

  // Stable signature for indicator config — used in effect deps.
  const configKey = useMemo(
    () =>
      indicators
        .map(
          (i) =>
            `${i.id}:${i.type}:${i.timeframe}:${JSON.stringify(i.params)}`,
        )
        .join('|'),
    [indicators],
  );

  /* -------- Auto-effect: per-timeframe parallel fetch + compute -------- */
  useEffect(() => {
    let cancelled = false;
    if (!symbol || indicators.length === 0) return;

    const uniqueTfs = Array.from(new Set(indicators.map((i) => i.timeframe)));

    setAutoLoadingTfs(new Set(uniqueTfs));
    setAutoErrors(new Map());

    for (const tf of uniqueTfs) {
      (async () => {
        try {
          const candles = await getCachedKlines(symbol, tf, autoRangeFor(tf), cryptoUniverse);
          if (cancelled) return;
          // Update auto data for indicators on this timeframe
          setAutoData((prev) => {
            const next = new Map(prev);
            for (const ind of indicators) {
              if (ind.timeframe === tf) {
                next.set(ind.id, computeAutoPerformance(candles, ind));
              }
            }
            return next;
          });
        } catch (err) {
          if (cancelled) return;
          const msg =
            err instanceof Error ? err.message : 'Failed to load market data';
          setAutoErrors((prev) => new Map(prev).set(tf, msg));
        } finally {
          if (cancelled) return;
          setAutoLoadingTfs((prev) => {
            const next = new Set(prev);
            next.delete(tf);
            return next;
          });
        }
      })();
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, configKey, refreshKey]);

  /* -------------------- Click-based yearly loader -------------------- */
  const runYearly = useCallback(
    async (indicatorId: string) => {
      const ind = indicators.find((i) => i.id === indicatorId);
      if (!ind || !symbol) return;
      const tf = ind.timeframe;

      setYearlyLoadingTfs((s) => {
        const next = new Set(s);
        next.add(tf);
        return next;
      });
      setYearlyErrors((s) => {
        const next = new Map(s);
        next.delete(tf);
        return next;
      });

      try {
        const candles = await getCachedKlines(symbol, tf, YEARLY_RANGE_MS, cryptoUniverse);
        const matched = indicators.filter((i) => i.timeframe === tf);
        setYearlyData((prev) => {
          const next = new Map(prev);
          for (const matchInd of matched) {
            next.set(matchInd.id, computeYearly(candles, matchInd));
          }
          return next;
        });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Failed to compute yearly';
        setYearlyErrors((s) => new Map(s).set(tf, msg));
      } finally {
        setYearlyLoadingTfs((s) => {
          const next = new Set(s);
          next.delete(tf);
          return next;
        });
      }
    },
    [indicators, symbol, cryptoUniverse],
  );

  const retry = useCallback(() => {
    invalidateShared(symbol);
    setRefreshKey((k) => k + 1);
    setYearlyData(new Map());
    setYearlyLoadingTfs(new Set());
    setYearlyErrors(new Map());
  }, [symbol]);

  /* ----------------- Merge auto + yearly per indicator --------------- */
  const data = useMemo(() => {
    const merged = new Map<string, IndicatorPerformance>();
    for (const [id, p] of autoData) merged.set(id, { ...p });
    for (const [id, ystat] of yearlyData) {
      const existing = merged.get(id) ?? {
        candleCount: 0,
        startTime: null,
        endTime: null,
      };
      merged.set(id, { ...existing, yearly: ystat });
    }
    return merged;
  }, [autoData, yearlyData]);

  /* ---------------- Derived values exposed to consumers --------------- */
  const isLoadingFor = useCallback(
    (ind: IndicatorConfig) => autoLoadingTfs.has(ind.timeframe),
    [autoLoadingTfs],
  );
  const errorFor = useCallback(
    (ind: IndicatorConfig) => autoErrors.get(ind.timeframe) ?? null,
    [autoErrors],
  );
  const isYearlyLoading = useCallback(
    (ind: IndicatorConfig) => yearlyLoadingTfs.has(ind.timeframe),
    [yearlyLoadingTfs],
  );
  const yearlyErrorFor = useCallback(
    (ind: IndicatorConfig) => yearlyErrors.get(ind.timeframe) ?? null,
    [yearlyErrors],
  );

  // Global "any loading" / "all failed" flags for the panel header & banner.
  const globalLoading = autoLoadingTfs.size > 0;
  const globalError = useMemo(() => {
    if (autoErrors.size === 0) return null;
    const uniqueTfs = new Set(indicators.map((i) => i.timeframe));
    if (uniqueTfs.size > 0 && autoErrors.size >= uniqueTfs.size) {
      // All active timeframes errored; pick the first message.
      return Array.from(autoErrors.values())[0] ?? null;
    }
    return null;
  }, [autoErrors, indicators]);

  return {
    data,
    globalLoading,
    globalError,
    isLoadingFor,
    errorFor,
    isYearlyLoading,
    yearlyErrorFor,
    runYearly,
    retry,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Compute helpers                               */
/* -------------------------------------------------------------------------- */

function emptyStat(): PerformanceStat {
  return {
    totalReturnPercent: 0,
    numberOfTrades: 0,
    winRate: 0,
    available: false,
  };
}

function computeAutoPerformance(
  candles: Candle[],
  ind: IndicatorConfig,
): IndicatorPerformance {
  const out: IndicatorPerformance = {
    daily: emptyStat(),
    weekly: emptyStat(),
    monthly: emptyStat(),
    candleCount: candles.length,
    startTime: candles.length ? candles[0].time : null,
    endTime: candles.length ? candles[candles.length - 1].time : null,
  };
  if (candles.length === 0) return out;

  for (const key of ['daily', 'weekly', 'monthly'] as const) {
    out[key] = computeRange(candles, ind, RANGES[key]);
  }
  return out;
}

function computeYearly(
  candles: Candle[],
  ind: IndicatorConfig,
): PerformanceStat {
  if (candles.length === 0) return emptyStat();
  return computeRange(candles, ind, RANGES.yearly);
}

function computeRange(
  candles: Candle[],
  ind: IndicatorConfig,
  rangeMs: number,
): PerformanceStat {
  if (candles.length === 0) return emptyStat();
  const lastSec = candles[candles.length - 1].time;
  const lastMs = lastSec * 1000;
  const startMs = lastMs - rangeMs;
  const startSec = Math.floor(startMs / 1000);
  const evalStart = indexFor(candles, startSec);

  if (candles.length - evalStart < 5) return emptyStat();

  const strategy = defaultStrategyFor(ind);
  try {
    // Backtest over the *whole* candle history so the long/short state at
    // the window's left edge reflects what really happened, not an
    // artificial reset. Trades are then filtered to the requested range
    // for display. Long-short mode means SELL signals open shorts instead
    // of sitting in cash — strategies can profit on the way down too.
    const result = runBacktest(candles, strategy, {
      symbol: ind.id,
      timeframe: ind.timeframe,
      initialCapital: 10_000,
      commission: 0.001,
      direction: 'long-short',
    });
    return {
      ...filterToRange(result, candles[evalStart].time),
      available: true,
    };
  } catch (err) {
    console.warn('Performance calc failed:', err);
    return emptyStat();
  }
}

function indexFor(candles: Candle[], targetSec: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  if (candles.length === 0 || candles[0].time >= targetSec) return 0;
  if (candles[hi].time < targetSec) return candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].time < targetSec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface RangeAggregate {
  totalReturnPercent: number;
  numberOfTrades: number;
  winRate: number;
}

function filterToRange(
  result: BacktestResult,
  startTimeSec: number,
): RangeAggregate {
  const trades = result.trades.filter((t) => t.time >= startTimeSec);
  const equity = result.equity.filter((e) => e.time >= startTimeSec);
  if (equity.length < 2) {
    return {
      totalReturnPercent: 0,
      numberOfTrades: trades.length,
      winRate: 0,
    };
  }
  const startEq = equity[0].value;
  const endEq = equity[equity.length - 1].value;
  const ret = startEq > 0 ? ((endEq - startEq) / startEq) * 100 : 0;

  // Any trade carrying a realised pnl is a closed round-trip. In long-short
  // mode that includes BUY trades that closed a prior short — filtering by
  // `type === 'SELL'` here would silently drop those from the win-rate
  // calculation.
  const closed = trades.filter((t) => t.pnl !== undefined);
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

  return {
    totalReturnPercent: ret,
    // Show closed round-trips rather than every signal event so the win-rate
    // denominator matches the displayed trade count — "3 tr · 67% win" is
    // legible; "5 tr · 67% win" with two of those being still-open entries
    // confuses the math.
    numberOfTrades: closed.length,
    winRate,
  };
}

export { invalidateKlinesCache } from '../lib/klinesCache';
