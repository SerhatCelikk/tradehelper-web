'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/store';
import { useOptimizer } from '../hooks/useOptimizer';
import {
  HORIZON_DAYS,
  HORIZON_LABELS,
  type OptimizerHorizon,
  type OptimizerResult,
} from '../lib/optimizer';
import {
  TIMEFRAMES,
  type IndicatorParams,
  type IndicatorType,
  type Timeframe,
} from '../lib/types';
import { Check, Loader, Play, RefreshCw, Target, X } from './icons';

interface Props {
  symbol: string;
  /** Chart's current timeframe — used as the initial selection. */
  initialTimeframe: Timeframe;
  onClose: () => void;
}

const INDICATOR_ORDER: IndicatorType[] = ['RSI', 'MACD', 'BBANDS', 'SMA', 'EMA'];

/**
 * Friendly indicator labels — matches what `formatHeader` in the indicator
 * performance card shows so the user doesn't see one name there ("Bollinger")
 * and a different cryptic one here ("BBANDS").
 */
const INDICATOR_LABELS: Record<IndicatorType, string> = {
  RSI: 'RSI',
  MACD: 'MACD',
  BBANDS: 'Bollinger Bands',
  SMA: 'SMA',
  EMA: 'EMA',
};

const HORIZONS: { value: OptimizerHorizon; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

export default function OptimizerModal({
  symbol,
  initialTimeframe,
  onClose,
}: Props) {
  const [selectedTf, setSelectedTf] = useState<Timeframe>(initialTimeframe);
  const [selectedHorizon, setSelectedHorizon] =
    useState<OptimizerHorizon>('monthly');
  const [showAll, setShowAll] = useState(false);

  const { status, progress, saved, error, candleCount, start, cancel } =
    useOptimizer(symbol, selectedTf, selectedHorizon, true);

  const replaceOrAddIndicator = useAppStore((s) => s.replaceOrAddIndicator);
  const setFocusedIndicator = useAppStore((s) => s.setFocusedIndicator);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const bestPerType = useMemo<Partial<Record<IndicatorType, OptimizerResult>>>(
    () => progress?.bestPerType ?? saved?.bestPerType ?? {},
    [progress, saved],
  );
  const allResults: OptimizerResult[] =
    progress?.topResults ?? saved?.results ?? [];

  // Per-type rows sorted by test-window return so the strongest setup of
  // each indicator family surfaces at the top.
  const perTypeRows = useMemo(() => {
    const rows = INDICATOR_ORDER.map((type) => bestPerType[type]).filter(
      (r): r is OptimizerResult => Boolean(r),
    );
    return rows.sort(
      (a, b) => b.outSampleReturnScore - a.outSampleReturnScore,
    );
  }, [bestPerType]);

  const isRunning = status === 'running' || status === 'loading';
  const phaseLabel = useMemo(() => {
    if (!progress) return null;
    switch (progress.phase) {
      case 'coarse':
        return 'Coarse search';
      case 'refine':
        return 'Refining';
      case 'local':
        return 'Local tuning';
      default:
        return 'Done';
    }
  }, [progress]);

  const percent =
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0;

  // How many real days the test window covers, given the requested horizon
  // and the available data. May be less than `HORIZON_DAYS[horizon]` for
  // young pairs where the optimizer fell back to a 50/50 split.
  const coveragedays = useMemo(() => {
    const diag = progress?.diagnostics ?? {
      testCandles: saved?.testCandles ?? 0,
    };
    if (!diag.testCandles) return null;
    const tfMs = tfToMs(selectedTf);
    return Math.round((diag.testCandles * tfMs) / 86_400_000);
  }, [progress, saved, selectedTf]);

  const handleApply = (row: OptimizerResult) => {
    replaceOrAddIndicator(row.type, row.params, selectedTf);
    setFocusedIndicator(null);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[92vh] flex flex-col rounded-lg border border-border bg-background-secondary p-5 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Target size={16} className="text-accent" />
            <h3 className="font-semibold">
              Optimize ·{' '}
              <span className="text-foreground-muted font-normal">{symbol}</span>
            </h3>
          </div>
          <button
            className="btn-ghost p-1"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Selectors */}
        <div className="grid sm:grid-cols-2 gap-4 mb-4 flex-shrink-0">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-1.5">
              Indicator timeframe
            </div>
            <div className="flex flex-wrap items-center gap-1 bg-background-tertiary rounded-md p-0.5 w-fit">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.value}
                  onClick={() => setSelectedTf(tf.value)}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${
                    selectedTf === tf.value
                      ? 'bg-accent text-white'
                      : 'text-foreground-muted hover:text-foreground'
                  }`}
                  disabled={isRunning}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-1.5">
              Best return over
            </div>
            <div className="flex items-center gap-1 bg-background-tertiary rounded-md p-0.5 w-fit">
              {HORIZONS.map((h) => (
                <button
                  key={h.value}
                  onClick={() => setSelectedHorizon(h.value)}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${
                    selectedHorizon === h.value
                      ? 'bg-accent text-white'
                      : 'text-foreground-muted hover:text-foreground'
                  }`}
                  disabled={isRunning}
                >
                  {h.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Method summary */}
        <div className="text-[11px] text-foreground-subtle mb-4 leading-relaxed flex-shrink-0">
          <div>
            <span className="text-foreground-muted">Goal:</span> Maximise total
            return on the <em>{HORIZON_LABELS[selectedHorizon]}</em>{' '}
            ({HORIZON_DAYS[selectedHorizon]} day
            {HORIZON_DAYS[selectedHorizon] > 1 ? 's' : ''}) of {selectedTf} bars.
            Strategies below the trade-count floor for the horizon are
            discounted so they can&apos;t accidentally win on zero activity.
          </div>
          <div>
            <span className="text-foreground-muted">Validation:</span> Train on
            everything older than the horizon, score on the last{' '}
            {HORIZON_LABELS[selectedHorizon]} only. Train metrics are shown
            for sanity-checking overfit.
          </div>
          <div>
            <span className="text-foreground-muted">Search:</span> Coarse grid
            (~430 combos) → refine top 3 per type → local hill-climb on the
            best of each type.
          </div>
          {candleCount > 0 && (
            <div>
              <span className="text-foreground-muted">Data:</span>{' '}
              {candleCount} bars
              {coveragedays !== null && (
                <> · test window covers ~{coveragedays} day{coveragedays === 1 ? '' : 's'}</>
              )}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between gap-3 mb-4 flex-shrink-0">
          <div className="text-xs text-foreground-muted min-w-0 truncate">
            {saved && status === 'idle' && (
              <>Last run: {formatRunAt(saved.runAt)}</>
            )}
            {status === 'loading' && 'Fetching candles…'}
            {status === 'running' && phaseLabel && (
              <>
                {phaseLabel} · {progress?.processed ?? 0}/
                {progress?.total ?? 0} ({percent}%)
              </>
            )}
            {status === 'error' && (
              <span className="text-danger">{error}</span>
            )}
            {!saved && status === 'idle' && 'No saved run for this combo yet.'}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isRunning ? (
              <button
                className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
                onClick={cancel}
              >
                <X size={12} /> Cancel
              </button>
            ) : (
              <button
                className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5"
                onClick={start}
              >
                {saved ? (
                  <>
                    <RefreshCw size={12} /> Re-scan
                  </>
                ) : (
                  <>
                    <Play size={12} /> Run optimization
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        {isRunning && (
          <div className="h-1.5 bg-background-tertiary rounded overflow-hidden mb-4 flex-shrink-0">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}

        {/* Leaderboard */}
        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          {perTypeRows.length === 0 && !isRunning && (
            <div className="text-center text-foreground-subtle text-sm py-10">
              {status === 'error'
                ? 'No results — see error above.'
                : 'Run optimization to see the top indicators.'}
            </div>
          )}

          {perTypeRows.length === 0 && isRunning && (
            <div className="flex items-center justify-center gap-2 text-accent text-sm py-10">
              <Loader size={14} />
              {status === 'loading'
                ? 'Loading data…'
                : 'Sweeping parameters — results will appear shortly…'}
            </div>
          )}

          {perTypeRows.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-2">
                Best of each indicator
              </div>
              <ul className="space-y-2">
                {perTypeRows.map((r, idx) => (
                  <LeaderboardRow
                    key={`type-${r.type}`}
                    rank={idx + 1}
                    row={r}
                    onApply={() => handleApply(r)}
                    disabled={isRunning}
                  />
                ))}
              </ul>

              {allResults.length > perTypeRows.length && (
                <div className="mt-4 pt-3 border-t border-border/60">
                  <button
                    className="text-[11px] text-foreground-muted hover:text-foreground flex items-center gap-1"
                    onClick={() => setShowAll((v) => !v)}
                  >
                    {showAll ? '▼' : '▶'} Show all top-10 configurations
                  </button>
                  {showAll && (
                    <ul className="space-y-2 mt-2">
                      {allResults.map((r, idx) => (
                        <LeaderboardRow
                          key={`all-${idx}-${r.type}-${JSON.stringify(r.params)}`}
                          rank={idx + 1}
                          row={r}
                          onApply={() => handleApply(r)}
                          disabled={isRunning}
                          compact
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Leaderboard                                 */
/* -------------------------------------------------------------------------- */

interface RowProps {
  rank: number;
  row: OptimizerResult;
  onApply: () => void;
  disabled: boolean;
  compact?: boolean;
}

function LeaderboardRow({ rank, row, onApply, disabled, compact }: RowProps) {
  const out = row.outSample;
  const inP = row.inSample;
  const returnTone = out
    ? out.totalReturnPercent > 0
      ? 'success'
      : out.totalReturnPercent < 0
        ? 'danger'
        : 'muted'
    : 'muted';
  return (
    <li
      className={`rounded border border-border bg-background-tertiary ${
        compact ? 'p-2' : 'p-3'
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono text-foreground-subtle">
              #{rank}
            </span>
            <span className="font-semibold text-sm">
              {INDICATOR_LABELS[row.type]}
            </span>
            <span className="text-xs text-foreground-muted font-mono truncate">
              {formatParams(row.type, row.params)}
            </span>
          </div>
        </div>
        <button
          className="btn-secondary text-[11px] px-2 py-1 flex items-center gap-1 flex-shrink-0 disabled:opacity-50"
          onClick={onApply}
          disabled={disabled}
        >
          <Check size={11} /> Apply
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5 text-[11px] font-mono tabular-nums">
        <Metric
          label="Test return"
          value={
            out
              ? `${out.totalReturnPercent >= 0 ? '+' : ''}${out.totalReturnPercent.toFixed(1)}%`
              : '—'
          }
          tone={returnTone}
          emphasis
        />
        <Metric
          label="Train return"
          value={
            inP
              ? `${inP.totalReturnPercent >= 0 ? '+' : ''}${inP.totalReturnPercent.toFixed(1)}%`
              : '—'
          }
          tone={
            inP && inP.totalReturnPercent >= 0 ? 'success' : 'muted'
          }
        />
        <Metric
          label="Trades"
          value={out ? String(out.numberOfTrades) : '—'}
          tone="muted"
        />
        <Metric
          label="Win"
          value={out ? `${out.winRate.toFixed(0)}%` : '—'}
          tone="muted"
        />
        <Metric
          label="DD"
          value={out ? `-${Math.abs(out.maxDrawdownPercent).toFixed(1)}%` : '—'}
          tone="muted"
        />
        <Metric
          label="Sharpe"
          value={
            out && Number.isFinite(out.sharpeRatio)
              ? out.sharpeRatio.toFixed(2)
              : '—'
          }
          tone="muted"
        />
        <Metric
          label="PF"
          value={
            out && Number.isFinite(out.profitFactor)
              ? out.profitFactor.toFixed(2)
              : '—'
          }
          tone="muted"
        />
        <Metric
          label="Composite"
          value={row.outSampleScore.toFixed(2)}
          tone="muted"
        />
      </div>
    </li>
  );
}

function Metric({
  label,
  value,
  tone,
  emphasis,
}: {
  label: string;
  value: string;
  tone: 'muted' | 'success' | 'danger';
  emphasis?: boolean;
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'danger'
        ? 'text-danger'
        : 'text-foreground';
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
        {label}
      </div>
      <div className={`${emphasis ? 'font-semibold text-sm' : ''} ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function formatParams(type: string, p: IndicatorParams): string {
  switch (type) {
    case 'RSI':
      return `period:${p.period} os:${p.oversold} ob:${p.overbought}`;
    case 'MACD':
      return `${p.fastPeriod}/${p.slowPeriod}/${p.signalPeriod} · ${p.macdMode}`;
    case 'BBANDS':
      return `period:${p.period} σ:${p.stdDev} · ${p.bbandsMode}`;
    case 'SMA':
    case 'EMA':
      return `period:${p.period} · ${p.maMode}${p.trendLookback ? ` lb:${p.trendLookback}` : ''}`;
    default:
      return JSON.stringify(p);
  }
}

function formatRunAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function tfToMs(tf: Timeframe): number {
  switch (tf) {
    case '1m':
      return 60_000;
    case '5m':
      return 5 * 60_000;
    case '15m':
      return 15 * 60_000;
    case '30m':
      return 30 * 60_000;
    case '1h':
      return 60 * 60_000;
    case '4h':
      return 4 * 60 * 60_000;
    case '1d':
      return 24 * 60 * 60_000;
    case '1w':
      return 7 * 24 * 60 * 60_000;
  }
}
