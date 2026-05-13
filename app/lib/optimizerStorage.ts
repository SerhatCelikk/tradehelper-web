import type { OptimizerHorizon, OptimizerResult } from './optimizer';
import type { IndicatorType, Timeframe } from './types';

/**
 * Persisted shape for one symbol+timeframe+horizon optimization run. The
 * `v` field lets us evolve the schema later — anything not matching the
 * current version is treated as missing on load (no migration logic).
 */
export interface SavedOptimization {
  v: 3;
  symbol: string;
  timeframe: Timeframe;
  horizon: OptimizerHorizon;
  runAt: string; // ISO timestamp
  metric: 'return';
  candleCount: number;
  trainCandles: number;
  testCandles: number;
  /** Top-10 across all indicator types, sorted by return on the test window. */
  results: OptimizerResult[];
  /** Best candidate of each indicator type (primary leaderboard view). */
  bestPerType: Partial<Record<IndicatorType, OptimizerResult>>;
}

const KEY_PREFIX = 'th_optimizer_';
const MAX_RESULTS = 5;

function keyFor(
  symbol: string,
  timeframe: Timeframe,
  horizon: OptimizerHorizon,
): string {
  return `${KEY_PREFIX}${symbol}_${timeframe}_${horizon}`;
}

export function saveOptimization(
  symbol: string,
  timeframe: Timeframe,
  horizon: OptimizerHorizon,
  payload: Omit<
    SavedOptimization,
    'v' | 'symbol' | 'timeframe' | 'horizon'
  >,
): void {
  if (typeof window === 'undefined') return;
  const full: SavedOptimization = {
    v: 3,
    symbol,
    timeframe,
    horizon,
    ...payload,
    // Trim to keep localStorage small; the modal only renders the top few
    // anyway and full grid dumps would balloon to hundreds of KB.
    results: payload.results.slice(0, MAX_RESULTS),
  };
  try {
    window.localStorage.setItem(
      keyFor(symbol, timeframe, horizon),
      JSON.stringify(full),
    );
  } catch (err) {
    console.warn('saveOptimization failed:', err);
  }
}

export function loadOptimization(
  symbol: string,
  timeframe: Timeframe,
  horizon: OptimizerHorizon,
): SavedOptimization | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(keyFor(symbol, timeframe, horizon));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedOptimization>;
    // Previous shape versions stored fewer fields; silently drop them rather
    // than try to migrate. The user just re-runs.
    if (parsed?.v !== 3) return null;
    if (!Array.isArray(parsed.results)) return null;
    if (!parsed.bestPerType || typeof parsed.bestPerType !== 'object') {
      return null;
    }
    return parsed as SavedOptimization;
  } catch (err) {
    console.warn('loadOptimization failed:', err);
    return null;
  }
}

export function clearOptimization(
  symbol: string,
  timeframe: Timeframe,
  horizon: OptimizerHorizon,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(keyFor(symbol, timeframe, horizon));
  } catch {
    /* ignore */
  }
}
