'use client';

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useAppStore } from '../store/store';
import { useBacktest } from '../hooks/useBacktest';
import { Plus, Trash, Play, Loader, Download } from './icons';
import {
  type BacktestSettings,
  type ConditionOperator,
  type IndicatorType,
  type Strategy,
  type StrategyCondition,
} from '../lib/types';

const PRESET_RANGES = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '180D', days: 180 },
  { label: '1Y', days: 365 },
];

const INDICATOR_OPTIONS: Array<{
  value: StrategyCondition['indicator'];
  label: string;
}> = [
  { value: 'PRICE', label: 'Price (Close)' },
  { value: 'RSI', label: 'RSI' },
  { value: 'MACD', label: 'MACD' },
  { value: 'BBANDS', label: 'Bollinger' },
  { value: 'SMA', label: 'SMA' },
  { value: 'EMA', label: 'EMA' },
];

const OPERATORS: Array<{ value: ConditionOperator; label: string }> = [
  { value: '>', label: '>' },
  { value: '<', label: '<' },
  { value: '>=', label: '≥' },
  { value: '<=', label: '≤' },
  { value: 'crosses_above', label: 'crosses above' },
  { value: 'crosses_below', label: 'crosses below' },
];

function newCondition(): StrategyCondition {
  return {
    id: `c${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    indicator: 'RSI',
    operator: '<',
    value: 30,
    valueType: 'number',
  };
}

export default function BacktestPanel() {
  const indicators = useAppStore((s) => s.indicators);
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const timeframe = useAppStore((s) => s.timeframe);
  const lastBacktest = useAppStore((s) => s.lastBacktest);

  const { run, isRunning, error } = useBacktest();

  const [logic, setLogic] = useState<'AND' | 'OR'>('AND');
  const [buyConditions, setBuyConditions] = useState<StrategyCondition[]>([
    { ...newCondition(), indicator: 'RSI', operator: '<', value: 30 },
  ]);
  const [sellConditions, setSellConditions] = useState<StrategyCondition[]>([
    { ...newCondition(), indicator: 'RSI', operator: '>', value: 70 },
  ]);
  const [days, setDays] = useState(30);
  const [initialCapital, setInitialCapital] = useState(10_000);
  const [commission, setCommission] = useState(0.001);

  const enabledIndicators = useMemo(
    () => indicators.filter((i) => i.enabled),
    [indicators],
  );

  const handleRun = async () => {
    if (buyConditions.length === 0 || sellConditions.length === 0) {
      toast.error('Add at least one buy and one sell condition.');
      return;
    }

    // Auto-enable any indicator referenced by conditions, so values exist.
    const referenced = new Set<IndicatorType>();
    for (const c of [...buyConditions, ...sellConditions]) {
      if (c.indicator !== 'PRICE') {
        referenced.add(c.indicator as IndicatorType);
      }
    }
    const ensured = indicators.map((i) =>
      referenced.has(i.type) ? { ...i, enabled: true } : i,
    );

    const strategy: Strategy = {
      name: `${selectedSymbol} ${timeframe} backtest`,
      indicators: ensured.filter((i) => i.enabled || referenced.has(i.type)),
      buyConditions,
      sellConditions,
      logic,
    };

    const endTime = Date.now();
    const startTime = endTime - days * 24 * 60 * 60 * 1000;

    const settings: BacktestSettings = {
      symbol: selectedSymbol,
      timeframe,
      startTime,
      endTime,
      initialCapital,
      commission,
    };

    const t = toast.loading('Running backtest…');
    await run(strategy, settings);
    toast.dismiss(t);
  };

  const exportCsv = () => {
    if (!lastBacktest) return;
    const rows = [
      ['type', 'time', 'price', 'quantity', 'pnl', 'pnlPercent'].join(','),
      ...lastBacktest.trades.map((t) =>
        [
          t.type,
          new Date(t.time * 1000).toISOString(),
          t.price,
          t.quantity,
          t.pnl ?? '',
          t.pnlPercent ?? '',
        ].join(','),
      ),
    ].join('\n');
    const blob = new Blob([rows], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backtest-${lastBacktest.symbol}-${lastBacktest.timeframe}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV exported');
  };

  return (
    <section className="panel">
      <h3 className="panel-header">Backtest</h3>

      {/* Strategy builder */}
      <div className="space-y-3">
        <div>
          <h4 className="text-xs font-semibold text-foreground-muted mb-2">
            Buy Conditions
          </h4>
          <ConditionList
            conds={buyConditions}
            onChange={setBuyConditions}
          />
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-foreground-muted">Logic:</span>
          <button
            className={`px-3 py-1 rounded text-xs ${
              logic === 'AND'
                ? 'bg-accent text-white'
                : 'bg-background-tertiary text-foreground-muted'
            }`}
            onClick={() => setLogic('AND')}
          >
            AND
          </button>
          <button
            className={`px-3 py-1 rounded text-xs ${
              logic === 'OR'
                ? 'bg-accent text-white'
                : 'bg-background-tertiary text-foreground-muted'
            }`}
            onClick={() => setLogic('OR')}
          >
            OR
          </button>
        </div>

        <div>
          <h4 className="text-xs font-semibold text-foreground-muted mb-2">
            Sell Conditions
          </h4>
          <ConditionList
            conds={sellConditions}
            onChange={setSellConditions}
          />
        </div>

        {/* Settings */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-foreground-subtle mb-1">
              Range
            </label>
            <div className="flex gap-1">
              {PRESET_RANGES.map((r) => (
                <button
                  key={r.label}
                  onClick={() => setDays(r.days)}
                  className={`flex-1 px-1 py-1 text-xs rounded ${
                    days === r.days
                      ? 'bg-accent text-white'
                      : 'bg-background-tertiary text-foreground-muted hover:text-foreground'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-foreground-subtle mb-1">
              Capital ($)
            </label>
            <input
              type="number"
              className="input text-sm py-1.5"
              min={100}
              value={initialCapital}
              onChange={(e) =>
                setInitialCapital(Number(e.target.value) || 10000)
              }
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-foreground-subtle mb-1">
              Commission (%)
            </label>
            <input
              type="number"
              className="input text-sm py-1.5"
              step="0.001"
              min={0}
              value={commission * 100}
              onChange={(e) =>
                setCommission(Math.max(0, Number(e.target.value) / 100))
              }
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-foreground-subtle mb-1">
              Days
            </label>
            <input
              type="number"
              className="input text-sm py-1.5"
              min={1}
              max={1825}
              value={days}
              onChange={(e) => setDays(Number(e.target.value) || 30)}
            />
          </div>
        </div>

        <button
          className="btn-primary w-full mt-2 flex items-center justify-center gap-2"
          onClick={handleRun}
          disabled={isRunning}
        >
          {isRunning ? (
            <>
              <Loader size={14} />
              Running…
            </>
          ) : (
            <>
              <Play size={14} />
              Run Backtest
            </>
          )}
        </button>

        {error && (
          <p className="text-xs text-danger px-1 py-1 bg-danger/10 rounded">
            {error}
          </p>
        )}

        {/* Results summary */}
        {lastBacktest && (
          <div className="pt-3 border-t border-border space-y-2">
            <div className="flex items-center justify-between mb-1">
              <h4 className="text-xs font-semibold text-foreground-muted uppercase">
                Results
              </h4>
              <button
                className="btn-ghost text-xs flex items-center gap-1"
                onClick={exportCsv}
                title="Export trades as CSV"
              >
                <Download size={12} />
                CSV
              </button>
            </div>
            <ResultGrid />
          </div>
        )}

        {enabledIndicators.length === 0 && (
          <p className="text-[11px] text-foreground-subtle">
            Tip: enable at least one indicator above to use it in a strategy.
          </p>
        )}
      </div>
    </section>
  );
}

function ConditionList({
  conds,
  onChange,
}: {
  conds: StrategyCondition[];
  onChange: (c: StrategyCondition[]) => void;
}) {
  return (
    <div className="space-y-2">
      {conds.map((c) => (
        <ConditionRow
          key={c.id}
          cond={c}
          onChange={(updated) =>
            onChange(conds.map((x) => (x.id === c.id ? updated : x)))
          }
          onRemove={() => onChange(conds.filter((x) => x.id !== c.id))}
        />
      ))}
      <button
        className="btn-ghost text-xs flex items-center gap-1 w-full justify-center py-1.5 border border-dashed border-border rounded"
        onClick={() => onChange([...conds, newCondition()])}
      >
        <Plus size={12} />
        Add condition
      </button>
    </div>
  );
}

function ConditionRow({
  cond,
  onChange,
  onRemove,
}: {
  cond: StrategyCondition;
  onChange: (c: StrategyCondition) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1 items-center">
      <select
        className="select text-xs py-1.5"
        value={cond.indicator}
        onChange={(e) =>
          onChange({
            ...cond,
            indicator: e.target.value as StrategyCondition['indicator'],
          })
        }
      >
        {INDICATOR_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="select text-xs py-1.5"
        value={cond.operator}
        onChange={(e) =>
          onChange({
            ...cond,
            operator: e.target.value as ConditionOperator,
          })
        }
      >
        {OPERATORS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <input
        type="number"
        className="input text-xs py-1.5"
        value={cond.value as number}
        step="0.0001"
        onChange={(e) =>
          onChange({ ...cond, value: Number(e.target.value), valueType: 'number' })
        }
      />
      <button
        className="btn-ghost p-1.5 text-foreground-muted hover:text-danger"
        onClick={onRemove}
        aria-label="Remove condition"
      >
        <Trash size={12} />
      </button>
    </div>
  );
}

function ResultGrid() {
  const r = useAppStore((s) => s.lastBacktest);
  if (!r) return null;
  const { performance } = r;
  const cells = [
    {
      label: 'Total',
      value: `${performance.totalReturnPercent.toFixed(2)}%`,
      tone: performance.totalReturnPercent >= 0 ? 'pos' : 'neg',
    },
    { label: 'Win Rate', value: `${performance.winRate.toFixed(1)}%` },
    { label: '# Trades', value: String(performance.numberOfTrades) },
    {
      label: 'Max DD',
      value: `${performance.maxDrawdownPercent.toFixed(2)}%`,
      tone: 'neg',
    },
    {
      label: 'Sharpe',
      value: performance.sharpeRatio.toFixed(2),
    },
    {
      label: 'PF',
      value: Number.isFinite(performance.profitFactor)
        ? performance.profitFactor.toFixed(2)
        : '∞',
    },
  ];
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {cells.map((c) => (
        <div
          key={c.label}
          className="rounded bg-background-tertiary px-2 py-1.5"
        >
          <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
            {c.label}
          </div>
          <div
            className={`text-sm font-mono font-semibold ${
              c.tone === 'pos'
                ? 'text-success'
                : c.tone === 'neg'
                  ? 'text-danger'
                  : 'text-foreground'
            }`}
          >
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}
