'use client';

import { useCallback, useState } from 'react';
import { useAppStore } from '../store/store';
import { fetchKlinesForRange } from '../lib/marketData';
import { runBacktest } from '../lib/backtest';
import { database } from '../lib/database';
import type {
  BacktestResult,
  BacktestSettings,
  Strategy,
} from '../lib/types';

export interface UseBacktestReturn {
  result: BacktestResult | null;
  isRunning: boolean;
  error: string | null;
  run: (strategy: Strategy, settings: BacktestSettings) => Promise<void>;
}

export function useBacktest(): UseBacktestReturn {
  const setLastBacktest = useAppStore((s) => s.setLastBacktest);
  const setBacktestRunning = useAppStore((s) => s.setBacktestRunning);
  const setShowBacktestPanel = useAppStore((s) => s.setShowBacktestPanel);
  const result = useAppStore((s) => s.lastBacktest);
  const isRunning = useAppStore((s) => s.isBacktestRunning);
  const allSymbols = useAppStore((s) => s.allSymbols);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (strategy: Strategy, settings: BacktestSettings) => {
      setError(null);
      setBacktestRunning(true);
      try {
        const cryptoUniverse = new Set(allSymbols);
        const rangeMs = Math.max(0, settings.endTime - settings.startTime);
        const candles = await fetchKlinesForRange(
          settings.symbol,
          settings.timeframe,
          rangeMs,
          cryptoUniverse,
        );
        if (candles.length < 30) {
          throw new Error(
            'Not enough historical candles for a meaningful backtest.',
          );
        }
        const backtestResult = runBacktest(candles, strategy, settings);
        setLastBacktest(backtestResult);
        setShowBacktestPanel(true);

        try {
          await database.saveBacktestResult(backtestResult);
        } catch (err) {
          console.warn('Failed to persist backtest result:', err);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Backtest failed';
        setError(msg);
        console.error('Backtest error:', err);
      } finally {
        setBacktestRunning(false);
      }
    },
    [setLastBacktest, setBacktestRunning, setShowBacktestPanel, allSymbols],
  );

  return { result, isRunning, error, run };
}
