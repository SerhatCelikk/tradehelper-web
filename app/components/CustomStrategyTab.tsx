'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/store';
import { describeStrategy } from '../lib/indicatorStrategies';
import {
  computeCompositeHints,
  simulateBacktestFromHints,
} from '../lib/compositeStrategy';
import type { BacktestPerformance, IndicatorConfig } from '../lib/types';
import { Loader, Play, Trash } from './icons';

/**
 * "My Strategy" tab — user composes a strategy by adding indicators (each
 * contributing its default buy/sell signal) and picking a single global
 * AND/OR connective. Hitting "Run on chart" simulates over the chart's
 * existing candle data and lets the resulting trade markers render on the
 * main chart via the usual `lastBacktest` store path.
 */
const INDICATOR_NAMES: Record<IndicatorConfig['type'], string> = {
  RSI: 'RSI',
  MACD: 'MACD',
  BBANDS: 'Bollinger Bands',
  SMA: 'SMA',
  EMA: 'EMA',
};

export default function CustomStrategyTab() {
  const customStrategy = useAppStore((s) => s.customStrategy);
  const removeFromCustomStrategy = useAppStore(
    (s) => s.removeFromCustomStrategy,
  );
  const setCustomStrategyLogic = useAppStore((s) => s.setCustomStrategyLogic);
  const setCustomStrategyShowOnChart = useAppStore(
    (s) => s.setCustomStrategyShowOnChart,
  );
  const setCustomStrategyFocused = useAppStore(
    (s) => s.setCustomStrategyFocused,
  );
  const clearCustomStrategy = useAppStore((s) => s.clearCustomStrategy);
  const candleData = useAppStore((s) => s.candleData);
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const timeframe = useAppStore((s) => s.timeframe);
  const setLastBacktest = useAppStore((s) => s.setLastBacktest);
  const lastBacktest = useAppStore((s) => s.lastBacktest);
  const allSymbols = useAppStore((s) => s.allSymbols);

  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPerf, setLastPerf] = useState<BacktestPerformance | null>(null);

  // Surface results from a previously-run strategy on first paint — saves
  // the user from having to re-click "Run" just to repopulate the summary
  // when they switch tabs back into My Strategy.
  useEffect(() => {
    if (!lastPerf && lastBacktest) setLastPerf(lastBacktest.performance);
    // We only want this to fire on first mount or when lastBacktest becomes
    // non-null from a fresh run; otherwise it would clobber `lastPerf`
    // updates that handleRun has already set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastBacktest]);

  const canRun =
    customStrategy.indicators.length >= 1 && candleData.length >= 30;

  const handleRun = useCallback(async () => {
    setError(null);
    if (customStrategy.indicators.length === 0) {
      setError('Add at least one indicator first.');
      return;
    }
    if (candleData.length < 30) {
      setError('Not enough chart data — wait for the chart to finish loading.');
      return;
    }
    setIsRunning(true);
    try {
      // Yield a frame so the Run button can paint its loading state before
      // the heavy work starts.
      await new Promise((r) => setTimeout(r, 16));
      // Pull each indicator's hint stream at ITS OWN timeframe, project onto
      // the chart bars, then combine via AND/OR. This is what makes
      // "RSI on 1h + BB on 5m" meaningful on a 1d chart — each indicator
      // speaks its native sampling rate and the composer aggregates per
      // chart bar.
      const cryptoUniverse = new Set(allSymbols);
      const hints = await computeCompositeHints({
        chartCandles: candleData,
        indicators: customStrategy.indicators,
        logic: customStrategy.logic,
        symbol: selectedSymbol,
        cryptoUniverse,
      });
      const result = simulateBacktestFromHints(candleData, hints, {
        symbol: selectedSymbol,
        timeframe,
        initialCapital: 10_000,
        commission: 0.001,
      });
      setLastBacktest(result);
      setLastPerf(result.performance);
    } catch (err) {
      console.error('Custom strategy run failed:', err);
      setError(err instanceof Error ? err.message : 'Backtest failed');
    } finally {
      setIsRunning(false);
    }
  }, [
    customStrategy.indicators,
    customStrategy.logic,
    candleData,
    selectedSymbol,
    timeframe,
    allSymbols,
    setLastBacktest,
  ]);

  // Auto-rerun when the chart context drifts away from what the last result
  // was computed for. Without this, switching from 4h to 1d leaves stale 4h
  // trade timestamps on the lastBacktest and the markers either disappear or
  // misalign. Guarded by `lastBacktest` so we only auto-run AFTER the user
  // has explicitly hit "Run" at least once — adding an indicator alone
  // shouldn't kick off a backtest behind their back.
  const lastRunKey = useRef<string | null>(null);
  const strategySignature = useMemo(
    () =>
      customStrategy.indicators
        .map((i) => `${i.type}:${i.timeframe}:${JSON.stringify(i.params)}`)
        .join('|') + `|${customStrategy.logic}`,
    [customStrategy.indicators, customStrategy.logic],
  );
  const candleCount = candleData.length;
  const lastCandleTime = candleData[candleData.length - 1]?.time ?? 0;

  useEffect(() => {
    if (!lastBacktest) return;
    if (customStrategy.indicators.length === 0) return;
    if (candleCount < 30) return;
    if (isRunning) return;

    const currentKey = `${selectedSymbol}|${timeframe}|${strategySignature}|${lastCandleTime}`;
    if (lastRunKey.current === currentKey) return;
    const contextChanged =
      lastBacktest.symbol !== selectedSymbol ||
      lastBacktest.timeframe !== timeframe;
    const strategyChanged = lastRunKey.current !== null
      ? !lastRunKey.current.includes(strategySignature)
      : false;
    if (!contextChanged && !strategyChanged) {
      lastRunKey.current = currentKey;
      return;
    }
    lastRunKey.current = currentKey;
    handleRun();
  }, [
    selectedSymbol,
    timeframe,
    strategySignature,
    lastCandleTime,
    candleCount,
    isRunning,
    lastBacktest,
    customStrategy.indicators.length,
    handleRun,
  ]);

  const handleClear = () => {
    clearCustomStrategy();
    setLastPerf(null);
    setError(null);
  };

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-border flex items-center justify-between gap-2 flex-shrink-0">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-foreground-muted uppercase tracking-wide">
            My Strategy
          </h2>
          <p className="text-[10px] text-foreground-subtle mt-0.5 leading-snug">
            Add indicators from the Indicators tab, pick how they combine,
            then run to see the trades on the chart.
          </p>
        </div>
        {customStrategy.indicators.length > 0 && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <label
              className="flex items-center gap-1.5 text-[10px] text-foreground-muted cursor-pointer px-1.5 py-1 rounded hover:bg-background-elevated"
              title="Render the composite strategy's buy/sell circles on the chart alongside the enabled indicators"
            >
              <input
                type="checkbox"
                className="checkbox h-3 w-3"
                checked={customStrategy.showOnChart}
                onChange={(e) =>
                  setCustomStrategyShowOnChart(e.target.checked)
                }
              />
              chart
            </label>
            <button
              type="button"
              onClick={() => setCustomStrategyFocused(!customStrategy.focused)}
              className={`text-[10px] px-1.5 py-1 rounded transition-colors ${
                customStrategy.focused
                  ? 'bg-accent text-white'
                  : 'text-foreground-muted hover:bg-background-elevated'
              }`}
              title={
                customStrategy.focused
                  ? 'Stop painting strategy zones on the chart'
                  : 'Paint long/short zones from this composite strategy onto the chart background'
              }
              aria-pressed={customStrategy.focused}
            >
              focus
            </button>
            <button
              className="btn-ghost text-[11px] px-2 py-1 flex items-center gap-1 text-foreground-muted"
              onClick={handleClear}
              title="Remove all indicators from this strategy"
            >
              <Trash size={11} />
              Clear
            </button>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {customStrategy.indicators.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <LogicSelector
              logic={customStrategy.logic}
              onChange={setCustomStrategyLogic}
              count={customStrategy.indicators.length}
            />

            <ul className="space-y-2">
              {customStrategy.indicators.map((ind) => (
                <li
                  key={ind.type}
                  className="rounded border border-border bg-background-tertiary p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: ind.color }}
                        />
                        <span className="font-semibold text-sm">
                          {formatIndicatorHeader(ind)}
                        </span>
                        <span className="text-[10px] font-mono text-foreground-subtle">
                          tf:{ind.timeframe}
                        </span>
                      </div>
                      <p className="text-[11px] text-foreground-muted mt-1 leading-snug">
                        {describeStrategy(ind)}
                      </p>
                    </div>
                    <button
                      className="btn-ghost p-1 text-foreground-subtle hover:text-danger flex-shrink-0"
                      onClick={() => removeFromCustomStrategy(ind.type)}
                      aria-label={`Remove ${ind.type}`}
                      title="Remove from strategy"
                    >
                      <Trash size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {customStrategy.indicators.length === 1 && (
              <div className="text-[11px] text-foreground-subtle bg-background-tertiary/50 border border-border/50 rounded px-3 py-2">
                Tip: with one indicator the AND / OR connective doesn&apos;t
                affect anything. Add more indicators to make the choice
                meaningful.
              </div>
            )}
          </>
        )}
      </div>

      <footer className="px-4 py-3 border-t border-border flex-shrink-0 space-y-2">
        {lastPerf && (
          <ResultsSummary perf={lastPerf} />
        )}
        {error && (
          <div className="text-xs text-danger bg-danger/10 border border-danger/30 rounded px-3 py-2">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] text-foreground-subtle">
            Backtests on the {candleData.length} bars currently loaded on the
            chart · long-short mode
          </div>
          <button
            className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
            onClick={handleRun}
            disabled={!canRun || isRunning}
          >
            {isRunning ? (
              <>
                <Loader size={12} /> Running…
              </>
            ) : (
              <>
                <Play size={12} /> Run on chart
              </>
            )}
          </button>
        </div>
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function LogicSelector({
  logic,
  onChange,
  count,
}: {
  logic: 'AND' | 'OR';
  onChange: (l: 'AND' | 'OR') => void;
  count: number;
}) {
  return (
    <div className="rounded border border-border bg-background-tertiary p-3">
      <div className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-2">
        Trigger when
      </div>
      <div className="flex items-center gap-1 bg-background-elevated rounded-md p-0.5 w-fit">
        <button
          className={`px-3 py-1 text-xs rounded transition-colors ${
            logic === 'AND'
              ? 'bg-accent text-white'
              : 'text-foreground-muted hover:text-foreground'
          }`}
          onClick={() => onChange('AND')}
        >
          ALL agree (AND)
        </button>
        <button
          className={`px-3 py-1 text-xs rounded transition-colors ${
            logic === 'OR'
              ? 'bg-accent text-white'
              : 'text-foreground-muted hover:text-foreground'
          }`}
          onClick={() => onChange('OR')}
        >
          ANY agrees (OR)
        </button>
      </div>
      <p className="text-[11px] text-foreground-muted mt-2 leading-snug">
        {logic === 'AND'
          ? `Buy fires only when all ${count} indicators signal BUY on the same bar; sell only when all signal SELL.`
          : `Buy fires when any of the ${count} indicators signals BUY; sell when any signals SELL.`}
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center text-foreground-subtle text-sm py-12 px-4 leading-relaxed">
      <p className="font-medium text-foreground-muted mb-1">
        No indicators in your strategy yet.
      </p>
      <p className="text-xs">
        Switch to the <span className="text-foreground">Indicators</span> tab
        and click the <span className="text-accent font-mono">+ strategy</span>{' '}
        button on any indicator card to add it here.
      </p>
    </div>
  );
}

function ResultsSummary({ perf }: { perf: BacktestPerformance }) {
  const tone =
    perf.totalReturnPercent > 0
      ? 'text-success'
      : perf.totalReturnPercent < 0
        ? 'text-danger'
        : 'text-foreground-muted';
  return (
    <div className="rounded border border-border/60 bg-background-tertiary/60 p-2.5">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-3 gap-y-1 text-[11px] font-mono tabular-nums">
        <Stat
          label="Return"
          value={`${perf.totalReturnPercent >= 0 ? '+' : ''}${perf.totalReturnPercent.toFixed(2)}%`}
          tone={tone}
          emphasis
        />
        <Stat label="Trades" value={String(perf.numberOfTrades)} />
        <Stat label="Win" value={`${perf.winRate.toFixed(0)}%`} />
        <Stat
          label="DD"
          value={`-${Math.abs(perf.maxDrawdownPercent).toFixed(1)}%`}
        />
        <Stat
          label="Sharpe"
          value={
            Number.isFinite(perf.sharpeRatio) ? perf.sharpeRatio.toFixed(2) : '—'
          }
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  emphasis,
}: {
  label: string;
  value: string;
  tone?: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
        {label}
      </div>
      <div className={`${emphasis ? 'font-semibold' : ''} ${tone ?? ''}`}>
        {value}
      </div>
    </div>
  );
}

function formatIndicatorHeader(ind: IndicatorConfig): string {
  const name = INDICATOR_NAMES[ind.type];
  switch (ind.type) {
    case 'RSI':
      return `${name}(${ind.params.period ?? 14})`;
    case 'MACD':
      return `${name}(${ind.params.fastPeriod ?? 12},${ind.params.slowPeriod ?? 26},${ind.params.signalPeriod ?? 9})`;
    case 'BBANDS':
      return `${name}(${ind.params.period ?? 20}, ${ind.params.stdDev ?? 2}σ)`;
    case 'SMA':
    case 'EMA':
      return `${name}(${ind.params.period ?? 20})`;
    default:
      return name;
  }
}
