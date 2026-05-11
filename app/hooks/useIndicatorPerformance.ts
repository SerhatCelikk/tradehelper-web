'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchKlinesRange } from '../lib/binance';
import { runBacktest } from '../lib/backtest';
import { defaultStrategyFor } from '../lib/indicatorStrategies';
import type {
  BacktestResult,
  Candle,
  IndicatorConfig,
  Timeframe,
} from '../lib/types';

const DAY = 86_400_000;

const AUTO_RANGE_MS = 31 * DAY; // covers daily/weekly/monthly with margin
const YEARLY_RANGE_MS = 365 * DAY;

const RANGES = {
  daily: 1 * DAY,
  weekly: 7 * DAY,
  monthly: 30 * DAY,
  yearly: 365 * DAY,
} as const;

/** Number of milliseconds per candle for each timeframe. */
const TIMEFRAME_MS: Record<Timeframe, number> = {
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
 * Hard cap to keep network usage reasonable. 50 iterations × 1000 candles
 * = 50k candles per timeframe — plenty for monthly even on 1m
 * (30 days × 24h × 60min ≈ 43k candles, fits in 44 iterations).
 */
const MAX_ITERATIONS = 50;

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
/*                Module-scope cache: one fetch per (symbol|tf)               */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  candles: Candle[];
  fetchedAt: number;
  /**
   * The maximum range that was *requested* for this entry. Future requests
   * for the same or smaller range get a cache hit even if the actual
   * coverage is shorter (because we couldn't fetch more — saturation).
   */
  requestedRangeMs: number;
}

const CACHE_TTL = 60_000;
const klinesCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Candle[]>>();

async function getKlines(
  symbol: string,
  timeframe: Timeframe,
  rangeMs: number,
): Promise<Candle[]> {
  const key = `${symbol}|${timeframe}`;
  const cached = klinesCache.get(key);
  if (
    cached &&
    Date.now() - cached.fetchedAt < CACHE_TTL &&
    cached.requestedRangeMs >= rangeMs
  ) {
    return cached.candles;
  }

  const inFlightKey = `${key}|${rangeMs}`;
  const existing = inFlight.get(inFlightKey);
  if (existing) return existing;

  const end = Date.now();
  const start = end - rangeMs;

  // Iteration count scales with timeframe so 1m/5m actually cover the range.
  const tfMs = TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS['4h'];
  const candlesNeeded = Math.ceil(rangeMs / tfMs);
  const itersNeeded = Math.ceil(candlesNeeded / 1000);
  const maxIterations = Math.min(itersNeeded + 1, MAX_ITERATIONS);

  const promise = fetchKlinesRange(symbol, timeframe, start, end, {
    maxIterations,
  })
    .then((candles) => {
      klinesCache.set(key, {
        candles,
        fetchedAt: Date.now(),
        requestedRangeMs: rangeMs,
      });
      return candles;
    })
    .finally(() => {
      inFlight.delete(inFlightKey);
    });
  inFlight.set(inFlightKey, promise);
  return promise;
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
          const candles = await getKlines(symbol, tf, AUTO_RANGE_MS);
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
        const candles = await getKlines(symbol, tf, YEARLY_RANGE_MS);
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
    [indicators, symbol],
  );

  const retry = useCallback(() => {
    invalidateKlinesCache(symbol);
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
  const minCandlesNeeded = warmupCandles(ind);
  const idxStart = Math.max(0, indexFor(candles, startSec) - minCandlesNeeded);
  const slice = candles.slice(idxStart);
  const evalStart = indexFor(slice, startSec);

  if (slice.length - evalStart < 5) return emptyStat();

  const strategy = defaultStrategyFor(ind);
  try {
    const result = runBacktest(slice, strategy, {
      symbol: ind.id,
      timeframe: ind.timeframe,
      initialCapital: 10_000,
      commission: 0.001,
    });
    return {
      ...filterToRange(result, slice[evalStart].time),
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

function warmupCandles(ind: IndicatorConfig): number {
  switch (ind.type) {
    case 'RSI':
      return (ind.params.period ?? 14) + 5;
    case 'MACD':
      return (
        (ind.params.slowPeriod ?? 26) + (ind.params.signalPeriod ?? 9) + 5
      );
    case 'BBANDS':
      return (ind.params.period ?? 20) + 5;
    case 'SMA':
    case 'EMA':
      return (ind.params.period ?? 20) + 5;
  }
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

  const closed = trades.filter((t) => t.type === 'SELL' && t.pnl !== undefined);
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

  return {
    totalReturnPercent: ret,
    numberOfTrades: trades.length,
    winRate,
  };
}

/** Manually invalidate the kline cache (e.g. after symbol change). */
export function invalidateKlinesCache(symbol?: string) {
  if (!symbol) {
    klinesCache.clear();
    return;
  }
  for (const k of Array.from(klinesCache.keys())) {
    if (k.startsWith(`${symbol}|`)) klinesCache.delete(k);
  }
}
