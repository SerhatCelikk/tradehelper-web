'use client';

import { useState } from 'react';
import { useAppStore } from '../store/store';
import {
  useIndicatorPerformance,
  type IndicatorPerformance,
} from '../hooks/useIndicatorPerformance';
import { describeStrategy } from '../lib/indicatorStrategies';
import IndicatorSettingsModal from './IndicatorSettingsModal';
import {
  Settings,
  RefreshCw,
  Loader,
  LineChart,
  AlertCircle,
  Play,
} from './icons';
import type { IndicatorConfig } from '../lib/types';
import { defaultConfigForType } from '../store/store';

const AUTO_RANGES: { key: 'daily' | 'weekly' | 'monthly'; label: string }[] = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

export default function IndicatorPerformancePanel() {
  const indicators = useAppStore((s) => s.indicators);
  const symbol = useAppStore((s) => s.selectedSymbol);
  const setIndicators = useAppStore((s) => s.setIndicators);

  const {
    data,
    globalLoading,
    globalError,
    isLoadingFor,
    errorFor,
    isYearlyLoading,
    yearlyErrorFor,
    runYearly,
    retry,
  } = useIndicatorPerformance(symbol, indicators);

  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = indicators.find((i) => i.id === editingId) ?? null;

  const handleSave = (next: IndicatorConfig) => {
    setIndicators(indicators.map((i) => (i.id === next.id ? next : i)));
    setEditingId(null);
  };

  const handleResetCard = (id: string) => {
    const current = indicators.find((i) => i.id === id);
    if (!current) return;
    const def = defaultConfigForType(current.type);
    setIndicators(
      indicators.map((i) =>
        i.id === id ? { ...def, id: i.id, enabled: i.enabled } : i,
      ),
    );
  };

  const handleToggleOverlay = (id: string) => {
    setIndicators(
      indicators.map((i) =>
        i.id === id ? { ...i, enabled: !i.enabled } : i,
      ),
    );
  };

  return (
    <section className="flex flex-col h-full">
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold text-foreground-muted uppercase tracking-wide flex items-center gap-2">
          <LineChart size={12} />
          Indicator performance
          <span className="text-foreground-subtle font-normal normal-case">
            · {symbol}
          </span>
        </h2>
        <div className="flex items-center gap-2 text-[11px] text-foreground-subtle">
          {globalLoading && (
            <span className="flex items-center gap-1 text-accent">
              <Loader size={11} />
              loading…
            </span>
          )}
          <button
            className="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-[11px]"
            onClick={retry}
            title="Refresh data"
          >
            <RefreshCw size={11} />
            refresh
          </button>
        </div>
      </header>

      {globalError && (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertCircle
              size={14}
              className="text-danger flex-shrink-0 mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-danger mb-1">
                Could not load market data
              </div>
              <div className="text-[11px] text-foreground-muted leading-relaxed break-words">
                {globalError}
              </div>
            </div>
            <button
              className="btn-secondary text-xs px-2 py-1 flex-shrink-0"
              onClick={retry}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {indicators.map((ind) => (
          <IndicatorCard
            key={ind.id}
            indicator={ind}
            performance={data.get(ind.id)}
            loading={isLoadingFor(ind)}
            error={errorFor(ind)}
            yearlyLoading={isYearlyLoading(ind)}
            yearlyError={yearlyErrorFor(ind)}
            onRunYearly={() => runYearly(ind.id)}
            onOpenSettings={() => setEditingId(ind.id)}
            onReset={() => handleResetCard(ind.id)}
            onToggleOverlay={() => handleToggleOverlay(ind.id)}
            onRetry={retry}
          />
        ))}
      </div>

      {editing && (
        <IndicatorSettingsModal
          config={editing}
          onSave={handleSave}
          onClose={() => setEditingId(null)}
        />
      )}
    </section>
  );
}

interface CardProps {
  indicator: IndicatorConfig;
  performance: IndicatorPerformance | undefined;
  loading: boolean;
  error: string | null;
  yearlyLoading: boolean;
  yearlyError: string | null;
  onRunYearly: () => void;
  onOpenSettings: () => void;
  onReset: () => void;
  onToggleOverlay: () => void;
  onRetry: () => void;
}

function IndicatorCard({
  indicator,
  performance,
  loading,
  error,
  yearlyLoading,
  yearlyError,
  onRunYearly,
  onOpenSettings,
  onReset,
  onToggleOverlay,
  onRetry,
}: CardProps) {
  const headerLine = formatHeader(indicator);
  const yearlyStat = performance?.yearly;
  const hasAuto = !!performance?.daily?.available;

  return (
    <article
      className={`rounded-lg border bg-background-tertiary overflow-hidden transition-colors ${
        loading
          ? 'border-accent/40'
          : error
            ? 'border-danger/40'
            : 'border-border'
      }`}
    >
      {/* Top progress bar when loading */}
      {loading && (
        <div className="h-0.5 bg-accent/20 overflow-hidden">
          <div className="h-full w-1/3 bg-accent animate-pulse" />
        </div>
      )}

      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/50">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: indicator.color }}
          />
          <div className="min-w-0">
            <div className="font-semibold text-sm truncate flex items-center gap-2">
              {headerLine}
              {loading && (
                <span className="inline-flex items-center gap-1 text-[10px] text-accent font-normal">
                  <Loader size={10} />
                  loading
                </span>
              )}
            </div>
            <div className="text-[10px] text-foreground-subtle truncate">
              {describeStrategy(indicator)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          <label
            className="flex items-center gap-1.5 text-[10px] text-foreground-muted cursor-pointer px-1.5 py-1 rounded hover:bg-background-elevated"
            title="Show overlay on the main chart"
          >
            <input
              type="checkbox"
              className="checkbox h-3 w-3"
              checked={indicator.enabled}
              onChange={onToggleOverlay}
            />
            chart
          </label>
          <button
            className="btn-ghost p-1.5 text-foreground-muted"
            onClick={onReset}
            title="Reset to default"
          >
            <RefreshCw size={13} />
          </button>
          <button
            className="btn-ghost p-1.5 text-foreground-muted"
            onClick={onOpenSettings}
            title="Settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Per-card error banner */}
      {error && !loading && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-2">
          <div className="flex items-center gap-2 text-[11px]">
            <AlertCircle size={12} className="text-danger flex-shrink-0" />
            <span className="text-foreground-muted flex-1 truncate" title={error}>
              {error}
            </span>
            <button
              className="btn-secondary text-[10px] px-2 py-0.5 flex-shrink-0"
              onClick={onRetry}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Stats grid (auto + yearly cell) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-border/40 relative">
        {AUTO_RANGES.map((r) => {
          const stat = performance?.[r.key];
          return (
            <StatCell
              key={r.key}
              label={r.label}
              stat={stat}
              loading={loading && !stat?.available}
            />
          );
        })}

        <YearlyCell
          stat={yearlyStat}
          loading={yearlyLoading}
          error={yearlyError}
          onRun={onRunYearly}
          disabled={loading || !hasAuto}
        />
      </div>

      <div className="px-3 py-1.5 bg-background-secondary border-t border-border/50 text-[10px] text-foreground-subtle flex items-center justify-between flex-wrap gap-1">
        <span>
          Backtest tf:{' '}
          <span className="text-foreground-muted font-mono">
            {indicator.timeframe}
          </span>
          {' · '}
          <span className="text-foreground-muted">
            $10k initial · 0.1% fee
          </span>
        </span>
        {performance?.endTime && performance.startTime && (
          <span title="Window covered by auto-loaded data">
            data: {formatDays(performance.endTime - performance.startTime)} ·{' '}
            {performance.candleCount} candles
          </span>
        )}
      </div>
    </article>
  );
}

function StatCell({
  label,
  stat,
  loading,
}: {
  label: string;
  stat?: { totalReturnPercent: number; numberOfTrades: number; winRate: number; available: boolean };
  loading: boolean;
}) {
  const value = stat?.totalReturnPercent ?? 0;
  const trades = stat?.numberOfTrades ?? 0;
  const winRate = stat?.winRate ?? 0;
  const available = stat?.available ?? false;

  if (loading) {
    return (
      <div className="px-3 py-3">
        <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
          {label}
        </div>
        <div className="mt-1 h-5 w-20 bg-background-elevated rounded animate-pulse" />
        <div className="mt-1 h-3 w-16 bg-background-elevated/50 rounded animate-pulse" />
      </div>
    );
  }
  if (!available) {
    return (
      <div className="px-3 py-3">
        <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
          {label}
        </div>
        <div className="mt-1 text-foreground-subtle text-sm font-mono">—</div>
      </div>
    );
  }
  const tone =
    trades === 0
      ? 'text-foreground-subtle'
      : value >= 0
        ? 'text-success'
        : 'text-danger';
  return (
    <div className="px-3 py-3">
      <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
        {label}
      </div>
      <div className={`mt-1 text-base font-mono font-semibold ${tone}`}>
        {value >= 0 ? '+' : ''}
        {value.toFixed(2)}%
      </div>
      <div className="text-[10px] text-foreground-subtle mt-0.5">
        {trades > 0
          ? `${trades} tr · ${winRate.toFixed(0)}% win`
          : '0 trades'}
      </div>
    </div>
  );
}

function YearlyCell({
  stat,
  loading,
  error,
  onRun,
  disabled,
}: {
  stat?: { totalReturnPercent: number; numberOfTrades: number; winRate: number; available: boolean };
  loading: boolean;
  error: string | null;
  onRun: () => void;
  disabled: boolean;
}) {
  if (loading) {
    return (
      <div className="px-3 py-3">
        <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
          Yearly
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-accent text-sm">
          <Loader size={12} />
          <span>running…</span>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-3 py-3">
        <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
          Yearly
        </div>
        <button
          className="mt-1 text-[10px] text-danger hover:underline text-left"
          onClick={onRun}
          title={error}
        >
          failed · retry
        </button>
      </div>
    );
  }
  if (!stat?.available) {
    return (
      <div className="px-3 py-3">
        <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
          Yearly
        </div>
        <button
          className="mt-1 inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onRun}
          disabled={disabled}
          title={
            disabled
              ? 'Wait for D/W/M to finish first'
              : 'Run yearly backtest (loads 365 days)'
          }
        >
          <Play size={10} />
          Run
        </button>
      </div>
    );
  }
  const value = stat.totalReturnPercent;
  const tone =
    stat.numberOfTrades === 0
      ? 'text-foreground-subtle'
      : value >= 0
        ? 'text-success'
        : 'text-danger';
  return (
    <div className="px-3 py-3 group relative">
      <div className="flex items-center justify-between">
        <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
          Yearly
        </div>
        <button
          className="text-[9px] text-foreground-subtle hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={onRun}
          title="Recompute yearly"
        >
          ↻
        </button>
      </div>
      <div className={`mt-1 text-base font-mono font-semibold ${tone}`}>
        {value >= 0 ? '+' : ''}
        {value.toFixed(2)}%
      </div>
      <div className="text-[10px] text-foreground-subtle mt-0.5">
        {stat.numberOfTrades > 0
          ? `${stat.numberOfTrades} tr · ${stat.winRate.toFixed(0)}% win`
          : '0 trades'}
      </div>
    </div>
  );
}

function formatHeader(ind: IndicatorConfig): string {
  switch (ind.type) {
    case 'RSI':
      return `RSI (${ind.params.period ?? 14})`;
    case 'MACD':
      return `MACD (${ind.params.fastPeriod ?? 12}, ${ind.params.slowPeriod ?? 26}, ${ind.params.signalPeriod ?? 9})`;
    case 'BBANDS':
      return `Bollinger (${ind.params.period ?? 20}, ${ind.params.stdDev ?? 2}σ)`;
    case 'SMA':
      return `SMA (${ind.params.period ?? 20})`;
    case 'EMA':
      return `EMA (${ind.params.period ?? 50})`;
  }
}

function formatDays(seconds: number): string {
  const days = seconds / 86400;
  if (days >= 7) return `${days.toFixed(0)}d`;
  if (days >= 1) return `${days.toFixed(1)}d`;
  const hours = seconds / 3600;
  return `${hours.toFixed(1)}h`;
}
