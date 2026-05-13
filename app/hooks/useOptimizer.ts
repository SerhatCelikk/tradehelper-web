'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/store';
import { getCachedKlines } from '../lib/klinesCache';
import {
  HORIZON_DAYS,
  runOptimization,
  type OptimizerHorizon,
  type OptimizerProgress,
  type OptimizerResult,
} from '../lib/optimizer';
import {
  loadOptimization,
  saveOptimization,
  type SavedOptimization,
} from '../lib/optimizerStorage';
import type { Timeframe } from '../lib/types';

const DAY = 86_400_000;
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
 * Total history to fetch. Aim for at least 4× the chosen horizon (so the
 * train window has 3× the depth of the test window — enough warmup plus
 * train statistics) but floor at 60 days for short-horizon scans and ceiling
 * at 3 years to keep fetch counts bounded on long timeframes.
 */
function fetchRangeFor(tf: Timeframe, horizon: OptimizerHorizon): number {
  const tfMs = TIMEFRAME_MS[tf] ?? TIMEFRAME_MS['4h'];
  const horizonMs = HORIZON_DAYS[horizon] * DAY;
  const target = horizonMs * 4;
  // Also make sure we have at least ~600 bars at this tf so the coarse grid
  // can do anything meaningful — short horizons on coarse timeframes would
  // otherwise give too few candles for SMA(100) / BBANDS(40) to warm up.
  const minByCandleCount = 600 * tfMs;
  return Math.min(
    3 * 365 * DAY,
    Math.max(60 * DAY, target, minByCandleCount),
  );
}

export type OptimizerStatus = 'idle' | 'loading' | 'running' | 'done' | 'error';

export interface UseOptimizerReturn {
  status: OptimizerStatus;
  progress: OptimizerProgress | null;
  saved: SavedOptimization | null;
  error: string | null;
  candleCount: number;
  start: () => Promise<void>;
  cancel: () => void;
  reloadSaved: () => void;
}

export function useOptimizer(
  symbol: string,
  timeframe: Timeframe,
  horizon: OptimizerHorizon,
  active: boolean,
): UseOptimizerReturn {
  const [status, setStatus] = useState<OptimizerStatus>('idle');
  const [progress, setProgress] = useState<OptimizerProgress | null>(null);
  const [saved, setSaved] = useState<SavedOptimization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [candleCount, setCandleCount] = useState(0);

  const cancelRef = useRef(false);
  const runIdRef = useRef(0);

  const allSymbols = useAppStore((s) => s.allSymbols);

  const reloadSaved = useCallback(() => {
    setSaved(loadOptimization(symbol, timeframe, horizon));
  }, [symbol, timeframe, horizon]);

  // Whenever the modal is open and any of the three context dimensions
  // (symbol / timeframe / horizon) changes, abort any running scan, refresh
  // the saved snapshot, and reset transient state so we don't bleed an old
  // run's leaderboard into the new combo.
  useEffect(() => {
    if (!active) return;
    cancelRef.current = true;
    runIdRef.current++;
    reloadSaved();
    setStatus('idle');
    setProgress(null);
    setError(null);
  }, [active, reloadSaved]);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const start = useCallback(async () => {
    if (status === 'running' || status === 'loading') return;
    cancelRef.current = false;
    const myRunId = ++runIdRef.current;

    setStatus('loading');
    setError(null);
    setProgress(null);

    try {
      const cryptoUniverse = new Set(allSymbols);
      const candles = await getCachedKlines(
        symbol,
        timeframe,
        fetchRangeFor(timeframe, horizon),
        cryptoUniverse,
      );
      if (runIdRef.current !== myRunId) return;
      if (cancelRef.current) {
        setStatus('idle');
        return;
      }
      setCandleCount(candles.length);

      if (candles.length < 90) {
        setStatus('error');
        setError(
          `Not enough history (${candles.length} bars). Try a longer timeframe or a different symbol.`,
        );
        return;
      }

      setStatus('running');

      const final = await runOptimization(
        candles,
        { timeframe, horizon },
        {
          onProgress: (p) => {
            if (runIdRef.current !== myRunId) return;
            setProgress(p);
          },
          shouldCancel: () => cancelRef.current,
        },
      );

      if (runIdRef.current !== myRunId) return;

      if (cancelRef.current) {
        setProgress(final);
        setStatus('idle');
        return;
      }

      setProgress(final);

      if (final.topResults.length > 0) {
        const payload = {
          runAt: new Date().toISOString(),
          metric: 'return' as const,
          candleCount: candles.length,
          trainCandles: final.diagnostics.trainCandles,
          testCandles: final.diagnostics.testCandles,
          results: final.topResults as OptimizerResult[],
          bestPerType: final.bestPerType,
        };
        saveOptimization(symbol, timeframe, horizon, payload);
        setSaved({
          v: 3,
          symbol,
          timeframe,
          horizon,
          ...payload,
          results: payload.results.slice(0, 5),
        });
      }
      setStatus('done');
    } catch (err) {
      if (runIdRef.current !== myRunId) return;
      console.error('optimizer run failed:', err);
      setError(err instanceof Error ? err.message : 'Optimization failed');
      setStatus('error');
    }
  }, [status, symbol, timeframe, horizon, allSymbols]);

  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

  return {
    status,
    progress,
    saved,
    error,
    candleCount,
    start,
    cancel,
    reloadSaved,
  };
}
