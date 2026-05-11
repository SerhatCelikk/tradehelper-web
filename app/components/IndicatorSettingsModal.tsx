'use client';

import { useEffect, useState } from 'react';
import {
  TIMEFRAMES,
  type BBandsMode,
  type IndicatorConfig,
  type MACDMode,
  type MAMode,
  type Timeframe,
} from '../lib/types';
import { defaultConfigForType } from '../store/store';
import { describeStrategy } from '../lib/indicatorStrategies';
import { X, RefreshCw, Check } from './icons';

interface Props {
  config: IndicatorConfig;
  onSave: (next: IndicatorConfig) => void;
  onClose: () => void;
}

export default function IndicatorSettingsModal({
  config,
  onSave,
  onClose,
}: Props) {
  const [draft, setDraft] = useState<IndicatorConfig>(config);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reset = () => {
    const def = defaultConfigForType(config.type);
    setDraft({
      ...def,
      id: config.id,
      enabled: config.enabled,
    });
  };

  const updateParams = (patch: Partial<IndicatorConfig['params']>) => {
    setDraft({ ...draft, params: { ...draft.params, ...patch } });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[90vh] flex flex-col rounded-lg border border-border bg-background-secondary p-5 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ backgroundColor: draft.color }}
            />
            <h3 className="font-semibold">{draft.type} settings</h3>
          </div>
          <button
            className="btn-ghost p-1"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <p className="text-xs text-foreground-subtle mb-4 flex-shrink-0">
          {describeStrategy(draft)}
        </p>

        <div className="flex-1 overflow-y-auto space-y-5 pr-1">
          {/* Timeframe — universal */}
          <Section title="Backtest timeframe">
            <div className="grid grid-cols-4 gap-1.5">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.value}
                  className={`px-2 py-1.5 rounded text-xs ${
                    draft.timeframe === tf.value
                      ? 'bg-accent text-white'
                      : 'bg-background-tertiary text-foreground-muted hover:text-foreground'
                  }`}
                  onClick={() =>
                    setDraft({ ...draft, timeframe: tf.value as Timeframe })
                  }
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </Section>

          {draft.type === 'RSI' && (
            <RSISection
              params={draft.params}
              onChange={updateParams}
            />
          )}
          {draft.type === 'MACD' && (
            <MACDSection
              params={draft.params}
              onChange={updateParams}
            />
          )}
          {draft.type === 'BBANDS' && (
            <BBandsSection
              params={draft.params}
              onChange={updateParams}
            />
          )}
          {(draft.type === 'SMA' || draft.type === 'EMA') && (
            <MASection
              params={draft.params}
              type={draft.type}
              onChange={updateParams}
            />
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2 flex-shrink-0 pt-3 border-t border-border">
          <button
            className="btn-secondary text-xs flex items-center gap-1.5"
            onClick={reset}
            title="Restore default parameters and 4h timeframe"
          >
            <RefreshCw size={12} />
            Reset to default
          </button>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary flex items-center gap-1.5"
              onClick={() => onSave(draft)}
            >
              <Check size={14} />
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              RSI settings                                  */
/* -------------------------------------------------------------------------- */

function RSISection({
  params,
  onChange,
}: {
  params: IndicatorConfig['params'];
  onChange: (p: Partial<IndicatorConfig['params']>) => void;
}) {
  return (
    <>
      <Section title="Indicator parameters">
        <Field label="Period">
          <input
            type="number"
            className="input"
            min={2}
            max={200}
            value={params.period ?? 14}
            onChange={(e) => onChange({ period: clamp(Number(e.target.value), 2, 200, 14) })}
          />
        </Field>
        <p className="text-[10px] text-foreground-subtle mt-2">
          Lower period = more sensitive (more signals). 14 is the textbook
          default.
        </p>
      </Section>

      <Section title="Trading thresholds">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Oversold (buy)">
            <input
              type="number"
              className="input"
              min={1}
              max={49}
              value={params.oversold ?? 30}
              onChange={(e) =>
                onChange({ oversold: clamp(Number(e.target.value), 1, 49, 30) })
              }
            />
          </Field>
          <Field label="Overbought (sell)">
            <input
              type="number"
              className="input"
              min={51}
              max={99}
              value={params.overbought ?? 70}
              onChange={(e) =>
                onChange({
                  overbought: clamp(Number(e.target.value), 51, 99, 70),
                })
              }
            />
          </Field>
        </div>
        <ThresholdScale
          oversold={params.oversold ?? 30}
          overbought={params.overbought ?? 70}
        />
        <p className="text-[10px] text-foreground-subtle mt-2">
          Tighter thresholds (e.g. 20 / 80) → fewer but stronger signals.
          Wider (35 / 65) → more frequent entries, more whipsaws.
        </p>
      </Section>
    </>
  );
}

function ThresholdScale({
  oversold,
  overbought,
}: {
  oversold: number;
  overbought: number;
}) {
  return (
    <div className="mt-3 relative h-7 rounded bg-background-tertiary overflow-hidden border border-border/60">
      <div
        className="absolute inset-y-0 bg-success/30"
        style={{ left: 0, width: `${oversold}%` }}
      />
      <div
        className="absolute inset-y-0 bg-danger/30"
        style={{ left: `${overbought}%`, right: 0 }}
      />
      <div
        className="absolute inset-y-0 w-px bg-success"
        style={{ left: `${oversold}%` }}
      />
      <div
        className="absolute inset-y-0 w-px bg-danger"
        style={{ left: `${overbought}%` }}
      />
      <div className="absolute inset-0 flex items-center justify-between px-2 text-[10px] font-mono text-foreground-muted">
        <span>0</span>
        <span className="text-success">{oversold}</span>
        <span className="text-danger">{overbought}</span>
        <span>100</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              MACD settings                                 */
/* -------------------------------------------------------------------------- */

const MACD_MODES: { value: MACDMode; label: string; hint: string }[] = [
  {
    value: 'signal_cross',
    label: 'Line crosses Signal',
    hint: 'Classic MACD: buy when MACD line crosses above signal, sell on opposite cross.',
  },
  {
    value: 'zero_cross',
    label: 'Line crosses Zero',
    hint: 'Trend filter: buy when MACD turns positive, sell when it turns negative. Fewer but later signals.',
  },
  {
    value: 'histogram_sign',
    label: 'Histogram sign change',
    hint: 'Earliest momentum shift: buy when histogram becomes positive, sell when negative.',
  },
];

function MACDSection({
  params,
  onChange,
}: {
  params: IndicatorConfig['params'];
  onChange: (p: Partial<IndicatorConfig['params']>) => void;
}) {
  const mode = params.macdMode ?? 'signal_cross';
  return (
    <>
      <Section title="Indicator parameters">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Fast EMA">
            <input
              type="number"
              className="input"
              min={2}
              max={200}
              value={params.fastPeriod ?? 12}
              onChange={(e) =>
                onChange({ fastPeriod: clamp(Number(e.target.value), 2, 200, 12) })
              }
            />
          </Field>
          <Field label="Slow EMA">
            <input
              type="number"
              className="input"
              min={2}
              max={500}
              value={params.slowPeriod ?? 26}
              onChange={(e) =>
                onChange({ slowPeriod: clamp(Number(e.target.value), 2, 500, 26) })
              }
            />
          </Field>
          <Field label="Signal">
            <input
              type="number"
              className="input"
              min={1}
              max={100}
              value={params.signalPeriod ?? 9}
              onChange={(e) =>
                onChange({
                  signalPeriod: clamp(Number(e.target.value), 1, 100, 9),
                })
              }
            />
          </Field>
        </div>
        <p className="text-[10px] text-foreground-subtle mt-2">
          Standard 12/26/9 is the most-traded combination. Wider periods
          (e.g. 19/39/9) reduce noise on higher timeframes.
        </p>
      </Section>

      <Section title="Signal mode">
        <ModeRadioGroup<MACDMode>
          value={mode}
          options={MACD_MODES}
          onChange={(v) => onChange({ macdMode: v })}
        />
      </Section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Bollinger settings                              */
/* -------------------------------------------------------------------------- */

const BB_MODES: { value: BBandsMode; label: string; hint: string }[] = [
  {
    value: 'mean_reversion',
    label: 'Mean reversion',
    hint: 'Counter-trend: buy when price punches through the lower band, sell when it crosses above the upper. Works in ranging markets.',
  },
  {
    value: 'breakout',
    label: 'Breakout',
    hint: 'With-trend: buy when price breaks above the upper band, sell when it falls through the lower. Works in trending markets.',
  },
];

function BBandsSection({
  params,
  onChange,
}: {
  params: IndicatorConfig['params'];
  onChange: (p: Partial<IndicatorConfig['params']>) => void;
}) {
  const mode = params.bbandsMode ?? 'mean_reversion';
  return (
    <>
      <Section title="Indicator parameters">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Period">
            <input
              type="number"
              className="input"
              min={2}
              max={300}
              value={params.period ?? 20}
              onChange={(e) =>
                onChange({ period: clamp(Number(e.target.value), 2, 300, 20) })
              }
            />
          </Field>
          <Field label="Std. deviation">
            <input
              type="number"
              className="input"
              step="0.1"
              min={0.5}
              max={5}
              value={params.stdDev ?? 2}
              onChange={(e) =>
                onChange({
                  stdDev: clampFloat(Number(e.target.value), 0.5, 5, 2),
                })
              }
            />
          </Field>
        </div>
        <p className="text-[10px] text-foreground-subtle mt-2">
          Tighter bands (1σ) → more frequent touches. Wider (2.5σ) → only
          extreme moves cross.
        </p>
      </Section>

      <Section title="Strategy">
        <ModeRadioGroup<BBandsMode>
          value={mode}
          options={BB_MODES}
          onChange={(v) => onChange({ bbandsMode: v })}
        />
      </Section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                              SMA / EMA settings                            */
/* -------------------------------------------------------------------------- */

const MA_MODES: { value: MAMode; label: string; hint: string }[] = [
  {
    value: 'price_cross',
    label: 'Price crossover',
    hint: 'Buy when price closes above the moving average, sell when it closes below.',
  },
  {
    value: 'price_cross_trend',
    label: 'Price crossover + trend',
    hint: 'Same crossover, but treats the rule as a trend-following filter (best on higher timeframes).',
  },
];

function MASection({
  params,
  type,
  onChange,
}: {
  params: IndicatorConfig['params'];
  type: 'SMA' | 'EMA';
  onChange: (p: Partial<IndicatorConfig['params']>) => void;
}) {
  const mode = params.maMode ?? 'price_cross';
  const periodHint =
    type === 'SMA'
      ? 'Common SMA periods: 20 (short), 50 (medium), 200 (long-term).'
      : 'Common EMA periods: 9 / 21 (short), 50 (medium), 200 (long-term).';

  return (
    <>
      <Section title="Indicator parameters">
        <Field label={`${type} period`}>
          <input
            type="number"
            className="input"
            min={2}
            max={500}
            value={params.period ?? (type === 'EMA' ? 50 : 20)}
            onChange={(e) =>
              onChange({ period: clamp(Number(e.target.value), 2, 500, 20) })
            }
          />
        </Field>
        <p className="text-[10px] text-foreground-subtle mt-2">{periodHint}</p>
      </Section>

      <Section title="Strategy">
        <ModeRadioGroup<MAMode>
          value={mode}
          options={MA_MODES}
          onChange={(v) => onChange({ maMode: v })}
        />
      </Section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Shared UI bits                                */
/* -------------------------------------------------------------------------- */

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold text-foreground-muted uppercase tracking-wide mb-2">
        {title}
      </h4>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wide text-foreground-subtle mb-1.5">
        {label}
      </span>
      {children}
    </label>
  );
}

function ModeRadioGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; hint: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="space-y-2">
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            className={`w-full text-left rounded-md border px-3 py-2.5 transition-colors ${
              selected
                ? 'border-accent bg-accent/10'
                : 'border-border bg-background-tertiary hover:border-foreground-subtle'
            }`}
            onClick={() => onChange(opt.value)}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-sm font-medium ${
                  selected ? 'text-foreground' : 'text-foreground-muted'
                }`}
              >
                {opt.label}
              </span>
              {selected && (
                <span className="text-[10px] text-accent flex-shrink-0">
                  active
                </span>
              )}
            </div>
            <p className="text-[10px] text-foreground-subtle mt-1 leading-snug">
              {opt.hint}
            </p>
          </button>
        );
      })}
    </div>
  );
}

function clamp(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function clampFloat(
  v: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}
