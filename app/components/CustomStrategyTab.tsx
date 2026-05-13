'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/store';
import { describeStrategy } from '../lib/indicatorStrategies';
import {
  computeCompositeHints,
  simulateBacktestFromHints,
} from '../lib/compositeStrategy';
import { getCachedKlines } from '../lib/klinesCache';
import type {
  BacktestPerformance,
  BacktestResult,
  IndicatorConfig,
} from '../lib/types';
import { AlertCircle, Check, Loader, Play, Trash } from './icons';

/**
 * "My Strategy" composer.
 *
 * UX is modelled after the Indicators tab: each card adds an indicator,
 * AND/OR picks how they combine, and the Backtest section sweeps the
 * composite across four standard horizons (Daily / Weekly / Monthly /
 * Yearly). "Calculate" loads D/W/M in parallel; Yearly is opt-in to keep
 * the heaviest fetch off the default path. Clicking a horizon card pipes
 * that run's trades to the main chart.
 *
 * Position sizing: 1× long (deploys all cash into the asset) and 1× short
 * (paper-trading approximation — sells the same cash-notional, PnL =
 * (entry − exit) × qty − fees, no margin maintenance modelled). No
 * leverage; capital risk per trade is whatever the input capital is.
 */
const INDICATOR_NAMES: Record<IndicatorConfig['type'], string> = {
  RSI: 'RSI',
  MACD: 'MACD',
  BBANDS: 'Bollinger Bands',
  SMA: 'SMA',
  EMA: 'EMA',
};

const DAY_MS = 86_400_000;

type Horizon = 'daily' | 'weekly' | 'monthly' | 'yearly';

const HORIZONS: { key: Horizon; label: string; days: number; tone: string }[] = [
  { key: 'daily', label: 'Daily', days: 1, tone: 'text-foreground' },
  { key: 'weekly', label: 'Weekly', days: 7, tone: 'text-foreground' },
  { key: 'monthly', label: 'Monthly', days: 30, tone: 'text-foreground' },
  { key: 'yearly', label: 'Yearly', days: 365, tone: 'text-foreground' },
];

const QUICK_HORIZONS: Horizon[] = ['daily', 'weekly', 'monthly'];

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
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const timeframe = useAppStore((s) => s.timeframe);
  const setLastBacktest = useAppStore((s) => s.setLastBacktest);
  const allSymbols = useAppStore((s) => s.allSymbols);

  const [capital, setCapital] = useState(10_000);
  const [commissionPct, setCommissionPct] = useState(0.1);

  const [results, setResults] = useState<
    Partial<Record<Horizon, BacktestResult>>
  >({});
  const [loading, setLoading] = useState<Set<Horizon>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<Horizon, string>>>({});
  const [selected, setSelected] = useState<Horizon>('monthly');

  // The store's `lastBacktest` mirrors whichever horizon the user is
  // currently inspecting so the chart's trade markers stay synchronised.
  // We push there on selection and after each successful run.
  useEffect(() => {
    const r = results[selected];
    if (r) setLastBacktest(r);
  }, [results, selected, setLastBacktest]);

  const canRun = customStrategy.indicators.length >= 1;

  const runOne = useCallback(
    async (horizon: Horizon): Promise<BacktestResult | null> => {
      setLoading((s) => {
        const next = new Set(s);
        next.add(horizon);
        return next;
      });
      setErrors((e) => {
        const next = { ...e };
        delete next[horizon];
        return next;
      });
      try {
        const days = HORIZONS.find((h) => h.key === horizon)!.days;
        const rangeMs = days * DAY_MS;
        const cryptoUniverse = new Set(allSymbols);
        const fetched = await getCachedKlines(
          selectedSymbol,
          timeframe,
          rangeMs,
          cryptoUniverse,
        );
        // The shared kline cache may have populated a *longer* window than
        // we asked for (e.g. the chart's own ~500-bar load runs first and
        // any subsequent request for ≤ that span is served straight from
        // cache). Without slicing, Daily / Weekly / Monthly would all
        // backtest the same big array and report identical numbers. Slice
        // down to the last `rangeMs` of bars so each horizon evaluates its
        // own window honestly.
        const cutoffSec = Math.floor((Date.now() - rangeMs) / 1000);
        const chartCandles = fetched.filter((c) => c.time >= cutoffSec);

        if (chartCandles.length < 5) {
          throw new Error(
            `Only ${chartCandles.length} bars available — try a finer chart timeframe.`,
          );
        }
        const hints = await computeCompositeHints({
          chartCandles,
          indicators: customStrategy.indicators,
          logic: customStrategy.logic,
          symbol: selectedSymbol,
          cryptoUniverse,
        });
        const result = simulateBacktestFromHints(chartCandles, hints, {
          symbol: selectedSymbol,
          timeframe,
          initialCapital: capital,
          commission: Math.max(0, commissionPct / 100),
        });
        setResults((r) => ({ ...r, [horizon]: result }));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Backtest failed';
        setErrors((e) => ({ ...e, [horizon]: message }));
        return null;
      } finally {
        setLoading((s) => {
          const next = new Set(s);
          next.delete(horizon);
          return next;
        });
      }
    },
    [
      customStrategy.indicators,
      customStrategy.logic,
      capital,
      commissionPct,
      selectedSymbol,
      timeframe,
      allSymbols,
    ],
  );

  const handleCalculate = useCallback(async () => {
    if (!canRun) return;
    // Fire D/W/M concurrently — they hit the shared kline cache for the
    // same symbol/timeframe pair, so the longer fetches absorb the shorter
    // ones with no extra round-trips.
    await Promise.all(QUICK_HORIZONS.map((h) => runOne(h)));
    // Surface the monthly run on the chart by default — it's the horizon
    // most people scan first.
    setSelected('monthly');
  }, [canRun, runOne]);

  const handleYearly = useCallback(async () => {
    if (!canRun) return;
    await runOne('yearly');
    setSelected('yearly');
  }, [canRun, runOne]);

  // Auto-rerun the calculated horizons when the strategy composition or
  // chart context changes — same guard as before: only fires AFTER at
  // least one manual Calculate so the user isn't blindsided.
  const lastRunKey = useRef<string | null>(null);
  const strategySignature = useMemo(
    () =>
      customStrategy.indicators
        .map((i) => `${i.type}:${i.timeframe}:${JSON.stringify(i.params)}`)
        .join('|') +
      `|${customStrategy.logic}` +
      `|${capital}|${commissionPct}`,
    [
      customStrategy.indicators,
      customStrategy.logic,
      capital,
      commissionPct,
    ],
  );

  useEffect(() => {
    const currentKey = `${selectedSymbol}|${timeframe}|${strategySignature}`;
    if (lastRunKey.current === null) {
      // No manual run yet; just record the baseline so the first manual
      // Calculate gets a key to compare against later.
      return;
    }
    if (lastRunKey.current === currentKey) return;
    if (Object.keys(results).length === 0) return;
    if (loading.size > 0) return;
    lastRunKey.current = currentKey;
    // Re-run only the horizons the user had already loaded — don't pull
    // yearly unless they had it.
    const horizonsToRefresh = Object.keys(results) as Horizon[];
    void Promise.all(horizonsToRefresh.map((h) => runOne(h)));
  }, [
    selectedSymbol,
    timeframe,
    strategySignature,
    results,
    loading.size,
    runOne,
  ]);

  // Track when we successfully completed any manual run so the auto-
  // rerun effect above starts watching.
  useEffect(() => {
    if (Object.keys(results).length > 0 && lastRunKey.current === null) {
      lastRunKey.current = `${selectedSymbol}|${timeframe}|${strategySignature}`;
    }
  }, [results, selectedSymbol, timeframe, strategySignature]);

  const handleClear = () => {
    clearCustomStrategy();
    setResults({});
    setErrors({});
    setLoading(new Set());
    lastRunKey.current = null;
  };

  const anyRunning = loading.size > 0;

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 py-2.5 border-b border-border flex items-center justify-between gap-2 flex-shrink-0">
        <div className="min-w-0 flex items-center gap-2">
          <h2 className="text-xs font-semibold text-foreground-muted uppercase tracking-wide">
            My Strategy
          </h2>
          <span className="text-[10px] text-foreground-subtle">
            · {selectedSymbol} · {timeframe}
          </span>
        </div>
        {customStrategy.indicators.length > 0 && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <label
              className="flex items-center gap-1.5 text-[10px] text-foreground-muted cursor-pointer px-1.5 py-1 rounded hover:bg-background-elevated"
              title="Render the composite strategy's buy/sell circles on the chart"
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
                  : 'Paint long/short zones from this strategy onto the chart background'
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

      <div className="flex-1 overflow-y-auto">
        {customStrategy.indicators.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="p-3 space-y-3">
            {/* Logic + indicators */}
            <CompactSection title="Trigger logic">
              <LogicSelector
                logic={customStrategy.logic}
                onChange={setCustomStrategyLogic}
                count={customStrategy.indicators.length}
              />
            </CompactSection>

            <CompactSection
              title={`Indicators (${customStrategy.indicators.length})`}
            >
              <ul className="space-y-1.5">
                {customStrategy.indicators.map((ind) => (
                  <li
                    key={ind.type}
                    className="flex items-start justify-between gap-2 rounded bg-background-tertiary/60 border border-border/60 px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: ind.color }}
                        />
                        <span className="font-semibold text-xs">
                          {formatIndicatorHeader(ind)}
                        </span>
                        <span className="text-[9px] font-mono text-foreground-subtle">
                          {ind.timeframe}
                        </span>
                      </div>
                      <p className="text-[10px] text-foreground-muted mt-0.5 leading-snug">
                        {describeStrategy(ind)}
                      </p>
                    </div>
                    <button
                      className="btn-ghost p-1 text-foreground-subtle hover:text-danger flex-shrink-0"
                      onClick={() => removeFromCustomStrategy(ind.type)}
                      aria-label={`Remove ${ind.type}`}
                    >
                      <Trash size={12} />
                    </button>
                  </li>
                ))}
              </ul>
              {customStrategy.indicators.length === 1 && (
                <p className="text-[10px] text-foreground-subtle mt-2">
                  Add a second indicator to make the AND/OR connective
                  meaningful.
                </p>
              )}
            </CompactSection>

            {/* Backtest settings */}
            <CompactSection title="Backtest settings">
              <div className="grid grid-cols-2 gap-2 mb-2">
                <SettingsInput
                  label="Capital ($)"
                  value={capital}
                  onChange={(n) => setCapital(Math.max(1, n))}
                  min={1}
                  step={100}
                  disabled={anyRunning}
                />
                <SettingsInput
                  label="Commission (%)"
                  value={commissionPct}
                  onChange={(n) => setCommissionPct(Math.max(0, n))}
                  min={0}
                  step={0.01}
                  disabled={anyRunning}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
                  onClick={handleCalculate}
                  disabled={!canRun || anyRunning}
                >
                  {anyRunning && QUICK_HORIZONS.some((h) => loading.has(h)) ? (
                    <>
                      <Loader size={12} /> Calculating…
                    </>
                  ) : (
                    <>
                      <Play size={12} /> Calculate
                    </>
                  )}
                </button>
                <button
                  className="btn-secondary text-xs px-2.5 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
                  onClick={handleYearly}
                  disabled={!canRun || loading.has('yearly')}
                  title="Run the yearly backtest separately — heavier than D/W/M, so it's opt-in."
                >
                  {loading.has('yearly') ? (
                    <Loader size={12} />
                  ) : (
                    <span className="text-[10px] font-mono">+1Y</span>
                  )}
                  Yearly
                </button>
                <span className="text-[10px] text-foreground-subtle ml-auto">
                  1× long / 1× short · no leverage
                </span>
              </div>
            </CompactSection>

            {/* Horizon result grid */}
            <CompactSection title="Results">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {HORIZONS.map((h) => (
                  <HorizonCard
                    key={h.key}
                    horizon={h}
                    result={results[h.key]}
                    loading={loading.has(h.key)}
                    error={errors[h.key]}
                    isSelected={selected === h.key}
                    onSelect={() => setSelected(h.key)}
                    onRun={() => runOne(h.key)}
                  />
                ))}
              </div>
              {results[selected] ? (
                // `key` forces React to unmount and remount the sparkline
                // whenever the horizon changes — otherwise the component
                // instance gets reused with `equity` prop swapped, and a
                // stale `useMemo` (or a paused HMR diff) can leave the
                // previous horizon's path on screen even though the data
                // updated.
                <EquitySparkline
                  key={selected}
                  equity={results[selected]!.equity}
                  initialCapital={capital}
                  horizonLabel={
                    HORIZONS.find((h) => h.key === selected)!.label
                  }
                />
              ) : (
                <div className="mt-3 text-[10px] text-foreground-subtle text-center py-3 border border-dashed border-border/60 rounded">
                  {loading.has(selected)
                    ? `Running ${HORIZONS.find((h) => h.key === selected)!.label} backtest…`
                    : errors[selected]
                      ? errors[selected]
                      : `No ${HORIZONS.find((h) => h.key === selected)!.label} run yet — click the card or run it to compute.`}
                </div>
              )}
            </CompactSection>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Sub-components                                */
/* -------------------------------------------------------------------------- */

function CompactSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-1.5 font-semibold">
        {title}
      </div>
      <div className="rounded border border-border bg-background-tertiary/40 p-2.5">
        {children}
      </div>
    </section>
  );
}

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
    <>
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
      <p className="text-[10px] text-foreground-muted mt-1.5 leading-snug">
        {logic === 'AND'
          ? `Buy fires only when all ${count} indicators are simultaneously in their BUY state; sell only when all are in SELL state.`
          : `Buy fires when any of the ${count} indicators enters its BUY state; sell when any enters SELL.`}
      </p>
    </>
  );
}

function SettingsInput({
  label,
  value,
  onChange,
  min,
  step,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-[9px] uppercase tracking-wide text-foreground-subtle mb-0.5">
        {label}
      </div>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        disabled={disabled}
        className="input text-xs w-full h-7"
      />
    </label>
  );
}

function HorizonCard({
  horizon,
  result,
  loading,
  error,
  isSelected,
  onSelect,
  onRun,
}: {
  horizon: { key: Horizon; label: string; days: number; tone: string };
  result: BacktestResult | undefined;
  loading: boolean;
  error: string | undefined;
  isSelected: boolean;
  onSelect: () => void;
  onRun: () => void;
}) {
  const perf: BacktestPerformance | undefined = result?.performance;
  const tone =
    perf == null
      ? 'text-foreground-muted'
      : perf.totalReturnPercent > 0
        ? 'text-success'
        : perf.totalReturnPercent < 0
          ? 'text-danger'
          : 'text-foreground-muted';

  // Clicking always selects the horizon (so the equity sparkline + chart
  // markers switch immediately, even before this card has data). If the
  // card has no result yet, also kick off the run.
  const handleClick = () => {
    onSelect();
    if (!result && !loading) onRun();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className={`text-left rounded border p-2 transition-colors disabled:opacity-70 ${
        isSelected
          ? 'border-accent bg-accent/5'
          : 'border-border bg-background-tertiary hover:border-border/80'
      }`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wide text-foreground-subtle font-semibold">
          {horizon.label}
        </span>
        {loading && <Loader size={10} className="text-accent" />}
        {!loading && result && isSelected && (
          <Check size={10} className="text-accent" />
        )}
      </div>

      {error ? (
        <div className="text-[10px] text-danger flex items-center gap-1">
          <AlertCircle size={10} />
          <span className="truncate">{error}</span>
        </div>
      ) : !result ? (
        <div className="text-[10px] text-foreground-subtle">
          {loading ? 'Loading…' : 'Click to run'}
        </div>
      ) : (
        <>
          <div className={`text-base font-mono font-semibold ${tone}`}>
            {perf!.totalReturnPercent >= 0 ? '+' : ''}
            {perf!.totalReturnPercent.toFixed(2)}%
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono tabular-nums text-foreground-muted mt-1">
            <span>Trades: {perf!.numberOfTrades}</span>
            <span>Win: {perf!.winRate.toFixed(0)}%</span>
            <span>DD: -{Math.abs(perf!.maxDrawdownPercent).toFixed(1)}%</span>
            <span>
              PF:{' '}
              {Number.isFinite(perf!.profitFactor)
                ? perf!.profitFactor.toFixed(2)
                : '—'}
            </span>
          </div>
        </>
      )}
    </button>
  );
}

function EquitySparkline({
  equity,
  initialCapital,
  horizonLabel,
}: {
  equity: { time: number; value: number }[];
  initialCapital: number;
  horizonLabel: string;
}) {
  const data = useMemo(() => {
    if (equity.length < 2) return null;
    const step = Math.max(1, Math.floor(equity.length / 200));
    const points: typeof equity = [];
    for (let i = 0; i < equity.length; i += step) points.push(equity[i]);
    if (points[points.length - 1] !== equity[equity.length - 1]) {
      points.push(equity[equity.length - 1]);
    }
    const values = points.map((p) => p.value);
    const min = Math.min(initialCapital, ...values);
    const max = Math.max(initialCapital, ...values);
    const range = max - min;

    const W = 600;
    const H = 50;
    const xStep = W / Math.max(1, points.length - 1);
    const flat = range < 0.0001;
    const baseY = flat
      ? H / 2
      : H - ((initialCapital - min) / range) * H;

    // Pre-compute screen coordinates per point so the hover handler can
    // map a mouse position to (time, value) without re-doing the maths.
    const screenPoints = points.map((p, i) => ({
      x: i * xStep,
      y: flat ? H / 2 : H - ((p.value - min) / range) * H,
      time: p.time,
      value: p.value,
    }));

    const linePath = screenPoints
      .map(
        (sp, i) =>
          `${i === 0 ? 'M' : 'L'} ${sp.x.toFixed(1)} ${sp.y.toFixed(1)}`,
      )
      .join(' ');

    return { linePath, baseY, W, H, flat, screenPoints, xStep };
  }, [equity, initialCapital]);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!data) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // Convert client x to SVG viewBox coordinates, then to the nearest
    // sampled point's index. Stays accurate as the SVG gets resized
    // because we work in viewBox space, not pixel space.
    const relX = ((e.clientX - rect.left) / rect.width) * data.W;
    const idx = Math.round(relX / data.xStep);
    const clamped = Math.max(0, Math.min(data.screenPoints.length - 1, idx));
    setHoverIdx(clamped);
  };

  if (!data) return null;
  const hovered = hoverIdx !== null ? data.screenPoints[hoverIdx] : null;

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1 min-h-[14px]">
        <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          Equity curve · {horizonLabel}
        </span>
        {hovered ? (
          <span className="text-[10px] font-mono tabular-nums text-foreground">
            {formatHoverDate(hovered.time)}
            {' · '}
            <span
              className={
                hovered.value >= initialCapital
                  ? 'text-success'
                  : 'text-danger'
              }
            >
              ${formatCurrency(hovered.value)}
            </span>
            <span className="text-foreground-subtle">
              {' '}
              ({hovered.value >= initialCapital ? '+' : ''}
              {(
                ((hovered.value - initialCapital) / initialCapital) *
                100
              ).toFixed(2)}
              %)
            </span>
          </span>
        ) : data.flat ? (
          <span className="text-[9px] text-foreground-subtle italic">
            no movement (likely zero trades)
          </span>
        ) : null}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${data.W} ${data.H}`}
        preserveAspectRatio="none"
        className="w-full h-12 text-accent cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <line
          x1={0}
          y1={data.baseY}
          x2={data.W}
          y2={data.baseY}
          stroke="currentColor"
          strokeWidth={0.5}
          strokeOpacity={0.3}
          strokeDasharray="3 3"
        />
        <path
          d={data.linePath}
          stroke="currentColor"
          strokeWidth={1.5}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        {hovered && (
          <>
            <line
              x1={hovered.x}
              y1={0}
              x2={hovered.x}
              y2={data.H}
              stroke="currentColor"
              strokeWidth={0.5}
              strokeOpacity={0.5}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={hovered.x}
              cy={hovered.y}
              r={2}
              fill="currentColor"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
    </div>
  );
}

function formatHoverDate(timeSec: number): string {
  if (!Number.isFinite(timeSec) || timeSec <= 0) return '—';
  const d = new Date(timeSec * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  // Show month + day always; include time only when the bar isn't aligned
  // to midnight (i.e. intraday timeframes). Keeps the tooltip short on
  // daily-tf charts and informative on 4h / 1h.
  const isMidnight =
    d.getHours() === 0 && d.getMinutes() === 0;
  if (isMidnight) {
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
    });
  }
  return d.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function EmptyState() {
  return (
    <div className="text-center text-foreground-subtle text-sm py-14 px-4 leading-relaxed">
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

function formatCurrency(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) {
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  return n.toFixed(2);
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
