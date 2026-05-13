import type {
  BacktestPerformance,
  BBandsMode,
  Candle,
  IndicatorConfig,
  IndicatorParams,
  IndicatorType,
  MACDMode,
  MAMode,
  Timeframe,
} from './types';
import { computePerformanceInRange, runBacktest } from './backtest';
import { defaultStrategyFor } from './indicatorStrategies';

/* -------------------------------------------------------------------------- */
/*                                  Types                                     */
/* -------------------------------------------------------------------------- */

export interface OptimizerCandidate {
  type: IndicatorType;
  params: IndicatorParams;
}

export interface OptimizerResult {
  type: IndicatorType;
  params: IndicatorParams;
  inSample: BacktestPerformance | null;
  outSample: BacktestPerformance | null;
  /** Composite (robust) score — Sharpe + PF + win-rate, used as tiebreaker. */
  inSampleScore: number;
  outSampleScore: number;
  /**
   * Primary ranking metric for "best return over the chosen horizon".
   * = total return % on the test window, penalised by a minimum-trade
   * floor so a no-trade strategy doesn't tie a real winner at 0 %.
   */
  inSampleReturnScore: number;
  outSampleReturnScore: number;
}

export type OptimizerHorizon = 'daily' | 'weekly' | 'monthly' | 'yearly';

export const HORIZON_DAYS: Record<OptimizerHorizon, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  yearly: 365,
};

export const HORIZON_LABELS: Record<OptimizerHorizon, string> = {
  daily: 'last day',
  weekly: 'last week',
  monthly: 'last month',
  yearly: 'last year',
};

export type OptimizerPhase = 'coarse' | 'refine' | 'local' | 'done';

export interface OptimizerProgress {
  phase: OptimizerPhase;
  processed: number;
  total: number;
  topResults: OptimizerResult[];
  /**
   * Highest-scoring candidate of each indicator type. Drives the per-type
   * leaderboard so non-RSI indicators don't get crowded out of the global
   * top-10 just because RSI has more parameter combinations.
   */
  bestPerType: Partial<Record<IndicatorType, OptimizerResult>>;
  /**
   * Diagnostic information about the data slices used. Lets the UI show
   * "Optimizing over last 28 days of 4h bars" honestly even when fewer
   * bars came back than nominally requested.
   */
  diagnostics: {
    totalCandles: number;
    trainCandles: number;
    testCandles: number;
  };
}

export interface OptimizerOptions {
  /** Top K per indicator type to refine. */
  topPerType?: number;
  /** Indicator + chart timeframe to evaluate on. */
  timeframe: Timeframe;
  /** The "best return over [horizon]" slice the optimizer is targeting. */
  horizon: OptimizerHorizon;
  /** Pause for the UI every N evaluations. */
  yieldEvery?: number;
}

export interface OptimizerCallbacks {
  onProgress?: (p: OptimizerProgress) => void;
  shouldCancel?: () => boolean;
}

/* -------------------------------------------------------------------------- */
/*                              Public scoring                                */
/* -------------------------------------------------------------------------- */

const SHARPE_CAP = 3;
const PF_CAP = 10;
const PF_LOG_DENOM = Math.log10(PF_CAP + 1); // normalises log10(pf+1) into [0,1]
const MIN_TRADES_FOR_FULL_CREDIT = 10;

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
 * Minimum trades expected on the test window for a result to count. Scales
 * with horizon — a yearly window should produce more activity than a daily
 * one. Strategies that fall below this threshold are still evaluated, but
 * their `returnScore` is the raw return divided in half, so they don't
 * leapfrog a genuinely-active strategy.
 */
function minTradesFor(horizon: OptimizerHorizon): number {
  switch (horizon) {
    case 'daily':
      return 1;
    case 'weekly':
      return 2;
    case 'monthly':
      return 4;
    case 'yearly':
      return 10;
  }
}

/**
 * Composite score in [0, 1]. Weighted Sharpe (40 %) + log-scaled profit factor
 * (40 %) + win rate (20 %), multiplied by a trade-count penalty so that
 * strategies with too few trades to be statistically meaningful score lower
 * than they would in isolation. Negative Sharpe and broken-math profit
 * factors clamp to 0 rather than going below it.
 */
export function scoreComposite(p: BacktestPerformance | null): number {
  if (!p) return 0;
  const sharpe = Number.isFinite(p.sharpeRatio) ? p.sharpeRatio : 0;
  const profitFactor = Number.isFinite(p.profitFactor) ? p.profitFactor : 0;
  const sharpeNorm = clamp(sharpe / SHARPE_CAP, 0, 1);
  const pfNorm = clamp(
    Math.log10(Math.max(0, profitFactor) + 1) / PF_LOG_DENOM,
    0,
    1,
  );
  const winRateNorm = clamp(p.winRate / 100, 0, 1);
  const tradePenalty = Math.min(1, p.numberOfTrades / MIN_TRADES_FOR_FULL_CREDIT);
  return (0.4 * sharpeNorm + 0.4 * pfNorm + 0.2 * winRateNorm) * tradePenalty;
}

/**
 * Primary ranking metric for "best return over the horizon". Returns the
 * total return %, possibly halved if the strategy didn't make enough trades
 * to be statistically meaningful for the horizon length. A null performance
 * (failed backtest) returns -Infinity so it sinks below any real result.
 */
export function scoreReturn(
  p: BacktestPerformance | null,
  horizon: OptimizerHorizon,
): number {
  if (!p) return Number.NEGATIVE_INFINITY;
  const ret = Number.isFinite(p.totalReturnPercent) ? p.totalReturnPercent : 0;
  const minTrades = minTradesFor(horizon);
  if (p.numberOfTrades < minTrades) {
    return ret * 0.5; // discounted but not eliminated
  }
  return ret;
}

/* -------------------------------------------------------------------------- */
/*                              Main entry point                              */
/* -------------------------------------------------------------------------- */

/**
 * Coarse → refine search across all five indicator types. Yields progress to
 * the supplied callback at controlled intervals and pauses for the UI thread
 * so a 10-30 s scan never freezes the page. Honours `shouldCancel()` between
 * batches to support a Cancel button.
 *
 * Returns the same shape as the last progress event would have carried,
 * so callers can use the return value as the "final" snapshot.
 */
export async function runOptimization(
  candles: Candle[],
  options: OptimizerOptions,
  callbacks?: OptimizerCallbacks,
): Promise<OptimizerProgress> {
  const topPerType = options.topPerType ?? 3;
  const yieldEvery = options.yieldEvery ?? 40;
  const horizon = options.horizon;

  // Decide where the test window starts. The test slice covers EXACTLY the
  // horizon the user picked (last 30 days, last year, etc.); everything
  // before is the train window. If the horizon would consume more than half
  // the available bars, fall back to a 50/50 split so we still have a
  // usable training tail.
  const tfMs = TIMEFRAME_MS[options.timeframe] ?? TIMEFRAME_MS['4h'];
  const horizonMs = HORIZON_DAYS[horizon] * 86_400_000;
  const desiredTestCount = Math.max(5, Math.ceil(horizonMs / tfMs));
  const maxTestCount = Math.floor(candles.length / 2);
  const testCount = Math.min(desiredTestCount, maxTestCount);
  const splitIdx = Math.max(0, candles.length - testCount);
  const trainCount = splitIdx;
  const actualTestCount = candles.length - splitIdx;

  // Both halves need enough bars to compute the indicator series and produce
  // at least a handful of trades. The thresholds are loose — we'd rather
  // return an empty leaderboard than mislead with garbage stats.
  if (trainCount < 60 || actualTestCount < 5) {
    return {
      phase: 'done',
      processed: 0,
      total: 0,
      topResults: [],
      bestPerType: {},
      diagnostics: {
        totalCandles: candles.length,
        trainCandles: trainCount,
        testCandles: actualTestCount,
      },
    };
  }

  const diagnostics = {
    totalCandles: candles.length,
    trainCandles: trainCount,
    testCandles: actualTestCount,
  };

  // Boundary timestamps used by `computePerformanceInRange`. Test starts
  // at the first bar after the split point; train covers everything before.
  const firstSec = candles[0].time;
  const testStartSec = candles[splitIdx].time;
  const lastSec = candles[candles.length - 1].time;
  // train range is [first, splitBoundary) — i.e. up to but not including
  // the first test bar.
  const trainEndSec = testStartSec - 1;

  const allResults: OptimizerResult[] = [];
  const seen = new Set<string>();

  /* ------------------------------- Phase 1 ------------------------------- */

  const coarse = generateCoarseCandidates();
  const phase1Total = coarse.length;
  let phase1Processed = 0;

  for (let i = 0; i < coarse.length; i++) {
    if (callbacks?.shouldCancel?.()) {
      return {
        phase: 'done',
        processed: phase1Processed,
        total: phase1Total,
        topResults: topK(allResults, 10),
        bestPerType: computeBestPerType(allResults),
        diagnostics,
      };
    }
    const c = coarse[i];
    const k = candidateKey(c);
    if (seen.has(k)) continue;
    seen.add(k);

    const result = evaluateCandidate(
      c,
      candles,
      firstSec,
      trainEndSec,
      testStartSec,
      lastSec,
      options.timeframe,
      horizon,
    );
    allResults.push(result);
    phase1Processed++;

    if (phase1Processed % yieldEvery === 0 || i === coarse.length - 1) {
      callbacks?.onProgress?.({
        phase: 'coarse',
        processed: phase1Processed,
        total: phase1Total,
        topResults: topK(allResults, 10),
        bestPerType: computeBestPerType(allResults),
        diagnostics,
      });
      await yieldToUI();
    }
  }

  /* ------------------------------- Phase 2 ------------------------------- */
  // For each indicator type, take its top-K coarse results and sweep a tight
  // grid around each one.

  const refineCandidates: OptimizerCandidate[] = [];
  const byType = groupByType(allResults);
  for (const type of Object.keys(byType) as IndicatorType[]) {
    const top = topK(byType[type] ?? [], topPerType);
    for (const r of top) {
      refineCandidates.push(...generateRefineCandidates({ type: r.type, params: r.params }));
    }
  }

  const phase2Total = refineCandidates.length;
  let phase2Processed = 0;

  for (let i = 0; i < refineCandidates.length; i++) {
    if (callbacks?.shouldCancel?.()) {
      return {
        phase: 'done',
        processed: phase2Processed,
        total: phase2Total,
        topResults: topK(allResults, 10),
        bestPerType: computeBestPerType(allResults),
        diagnostics,
      };
    }
    const c = refineCandidates[i];
    const k = candidateKey(c);
    if (seen.has(k)) continue;
    seen.add(k);

    const result = evaluateCandidate(
      c,
      candles,
      firstSec,
      trainEndSec,
      testStartSec,
      lastSec,
      options.timeframe,
      horizon,
    );
    allResults.push(result);
    phase2Processed++;

    if (phase2Processed % yieldEvery === 0 || i === refineCandidates.length - 1) {
      callbacks?.onProgress?.({
        phase: 'refine',
        processed: phase2Processed,
        total: phase2Total,
        topResults: topK(allResults, 10),
        bestPerType: computeBestPerType(allResults),
        diagnostics,
      });
      await yieldToUI();
    }
  }

  /* ------------------------------- Phase 3 ------------------------------- */
  // Local hill climb: take the current best of each indicator type and try
  // single-axis ±1 perturbations. Small (≤10 per type) but it catches obvious
  // wins that the coarse / refine grids skipped over.
  const localCandidates: OptimizerCandidate[] = [];
  for (const r of Object.values(computeBestPerType(allResults))) {
    if (!r) continue;
    localCandidates.push(...generateLocalCandidates({ type: r.type, params: r.params }));
  }

  const phase3Total = localCandidates.length;
  let phase3Processed = 0;

  for (let i = 0; i < localCandidates.length; i++) {
    if (callbacks?.shouldCancel?.()) {
      return {
        phase: 'done',
        processed: phase3Processed,
        total: phase3Total,
        topResults: topK(allResults, 10),
        bestPerType: computeBestPerType(allResults),
        diagnostics,
      };
    }
    const c = localCandidates[i];
    const k = candidateKey(c);
    if (seen.has(k)) continue;
    seen.add(k);

    const result = evaluateCandidate(
      c,
      candles,
      firstSec,
      trainEndSec,
      testStartSec,
      lastSec,
      options.timeframe,
      horizon,
    );
    allResults.push(result);
    phase3Processed++;

    if (phase3Processed % yieldEvery === 0 || i === localCandidates.length - 1) {
      callbacks?.onProgress?.({
        phase: 'local',
        processed: phase3Processed,
        total: phase3Total,
        topResults: topK(allResults, 10),
        bestPerType: computeBestPerType(allResults),
        diagnostics,
      });
      await yieldToUI();
    }
  }

  const final = topK(allResults, 10);
  const bestPerType = computeBestPerType(allResults);
  return {
    phase: 'done',
    processed: phase3Processed,
    total: phase3Total,
    topResults: final,
    bestPerType,
    diagnostics,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Candidate eval                                */
/* -------------------------------------------------------------------------- */

function evaluateCandidate(
  c: OptimizerCandidate,
  candles: Candle[],
  firstSec: number,
  trainEndSec: number,
  testStartSec: number,
  lastSec: number,
  timeframe: Timeframe,
  horizon: OptimizerHorizon,
): OptimizerResult {
  const config: IndicatorConfig = {
    id: `opt-${c.type}`,
    type: c.type,
    enabled: true,
    params: c.params,
    timeframe,
    color: '#000000',
  };
  let strategy;
  try {
    strategy = defaultStrategyFor(config);
  } catch (err) {
    console.warn('optimizer: defaultStrategyFor failed', err);
    return {
      type: c.type,
      params: c.params,
      inSample: null,
      outSample: null,
      inSampleScore: 0,
      outSampleScore: 0,
      inSampleReturnScore: Number.NEGATIVE_INFINITY,
      outSampleReturnScore: Number.NEGATIVE_INFINITY,
    };
  }

  // One continuous backtest over the full window — state evolves naturally
  // from the first bar through the test slice. Sub-range metrics are then
  // pulled out via `computePerformanceInRange`. This is what makes the
  // optimizer's numbers reproduce on the indicator performance panel:
  // both run a single backtest on the same data and slice the same way.
  let result;
  try {
    result = runBacktest(candles, strategy, {
      symbol: 'optimizer',
      timeframe,
      initialCapital: 10_000,
      commission: 0.001,
      direction: 'long-short',
    });
  } catch (err) {
    console.warn('optimizer: runBacktest failed', err);
    return {
      type: c.type,
      params: c.params,
      inSample: null,
      outSample: null,
      inSampleScore: 0,
      outSampleScore: 0,
      inSampleReturnScore: Number.NEGATIVE_INFINITY,
      outSampleReturnScore: Number.NEGATIVE_INFINITY,
    };
  }

  const inPerf = computePerformanceInRange(result, firstSec, trainEndSec);
  const outPerf = computePerformanceInRange(result, testStartSec, lastSec);

  return {
    type: c.type,
    params: c.params,
    inSample: inPerf,
    outSample: outPerf,
    inSampleScore: scoreComposite(inPerf),
    outSampleScore: scoreComposite(outPerf),
    inSampleReturnScore: scoreReturn(inPerf, horizon),
    outSampleReturnScore: scoreReturn(outPerf, horizon),
  };
}

/* -------------------------------------------------------------------------- */
/*                                Grid generators                             */
/* -------------------------------------------------------------------------- */

function generateCoarseCandidates(): OptimizerCandidate[] {
  const out: OptimizerCandidate[] = [];

  // RSI: 8 × 4 × 4 = 128
  for (const period of [5, 7, 10, 14, 17, 21, 28, 40]) {
    for (const oversold of [20, 25, 30, 35]) {
      for (const overbought of [65, 70, 75, 80]) {
        out.push({
          type: 'RSI',
          params: { period, oversold, overbought },
        });
      }
    }
  }

  // MACD: 5 × 4 × 3 × 3 with fast<slow filter ≈ 130
  const macdModes: MACDMode[] = ['signal_cross', 'zero_cross', 'histogram_sign'];
  for (const fastPeriod of [5, 8, 12, 15, 18]) {
    for (const slowPeriod of [20, 26, 32, 40]) {
      if (fastPeriod >= slowPeriod) continue;
      for (const signalPeriod of [7, 9, 12]) {
        for (const macdMode of macdModes) {
          out.push({
            type: 'MACD',
            params: { fastPeriod, slowPeriod, signalPeriod, macdMode },
          });
        }
      }
    }
  }

  // BBANDS: 7 × 6 × 2 = 84
  const bbModes: BBandsMode[] = ['mean_reversion', 'breakout'];
  for (const period of [10, 14, 18, 22, 26, 30, 40]) {
    for (const stdDev of [1.5, 1.8, 2, 2.2, 2.5, 3]) {
      for (const bbandsMode of bbModes) {
        out.push({
          type: 'BBANDS',
          params: { period, stdDev, bbandsMode },
        });
      }
    }
  }

  // SMA: 8 × 3 × 2 = 48 (capped at 100 so even a small test window still
  // leaves the train half enough bars to warm the MA up).
  const maModes: MAMode[] = ['price_cross', 'price_cross_trend'];
  for (const period of [5, 10, 15, 20, 30, 50, 75, 100]) {
    for (const trendLookback of [3, 5, 8]) {
      for (const maMode of maModes) {
        out.push({
          type: 'SMA',
          params: { period, trendLookback, maMode },
        });
      }
    }
  }
  // EMA: 8 × 3 × 2 = 48
  for (const period of [5, 9, 14, 21, 34, 50, 75, 100]) {
    for (const trendLookback of [3, 5, 8]) {
      for (const maMode of maModes) {
        out.push({
          type: 'EMA',
          params: { period, trendLookback, maMode },
        });
      }
    }
  }

  return out;
}

/**
 * Local hill climb: for each numeric parameter, try the value one step lower
 * and one step higher, holding everything else constant. Catches narrow local
 * optima that the coarse grid stepped past.
 */
function generateLocalCandidates(c: OptimizerCandidate): OptimizerCandidate[] {
  const out: OptimizerCandidate[] = [];
  switch (c.type) {
    case 'RSI': {
      const period = c.params.period ?? 14;
      const oversold = c.params.oversold ?? 30;
      const overbought = c.params.overbought ?? 70;
      for (const p of [period - 1, period + 1].filter((v) => v >= 2 && v <= 80)) {
        out.push({
          type: 'RSI',
          params: { period: p, oversold, overbought },
        });
      }
      for (const os of [oversold - 1, oversold + 1].filter((v) => v >= 5 && v <= overbought - 5)) {
        out.push({
          type: 'RSI',
          params: { period, oversold: os, overbought },
        });
      }
      for (const ob of [overbought - 1, overbought + 1].filter((v) => v <= 95 && v >= oversold + 5)) {
        out.push({
          type: 'RSI',
          params: { period, oversold, overbought: ob },
        });
      }
      return out;
    }
    case 'MACD': {
      const fast = c.params.fastPeriod ?? 12;
      const slow = c.params.slowPeriod ?? 26;
      const sig = c.params.signalPeriod ?? 9;
      const mode = (c.params.macdMode ?? 'signal_cross') as MACDMode;
      for (const f of [fast - 1, fast + 1].filter((v) => v >= 2 && v < slow)) {
        out.push({
          type: 'MACD',
          params: { fastPeriod: f, slowPeriod: slow, signalPeriod: sig, macdMode: mode },
        });
      }
      for (const s of [slow - 1, slow + 1].filter((v) => v > fast && v <= 80)) {
        out.push({
          type: 'MACD',
          params: { fastPeriod: fast, slowPeriod: s, signalPeriod: sig, macdMode: mode },
        });
      }
      for (const sg of [sig - 1, sig + 1].filter((v) => v >= 2 && v <= 25)) {
        out.push({
          type: 'MACD',
          params: { fastPeriod: fast, slowPeriod: slow, signalPeriod: sg, macdMode: mode },
        });
      }
      return out;
    }
    case 'BBANDS': {
      const period = c.params.period ?? 20;
      const stdDev = c.params.stdDev ?? 2;
      const mode = (c.params.bbandsMode ?? 'mean_reversion') as BBandsMode;
      for (const p of [period - 1, period + 1].filter((v) => v >= 5 && v <= 60)) {
        out.push({
          type: 'BBANDS',
          params: { period: p, stdDev, bbandsMode: mode },
        });
      }
      for (const sd of [
        Math.round((stdDev - 0.1) * 100) / 100,
        Math.round((stdDev + 0.1) * 100) / 100,
      ].filter((v) => v >= 1 && v <= 4)) {
        out.push({
          type: 'BBANDS',
          params: { period, stdDev: sd, bbandsMode: mode },
        });
      }
      return out;
    }
    case 'SMA':
    case 'EMA': {
      const period = c.params.period ?? 20;
      const trendLb = c.params.trendLookback ?? 5;
      const maMode = (c.params.maMode ?? 'price_cross') as MAMode;
      for (const p of [period - 1, period + 1].filter((v) => v >= 3 && v <= 200)) {
        out.push({
          type: c.type,
          params: { period: p, trendLookback: trendLb, maMode },
        });
      }
      for (const tl of [trendLb - 1, trendLb + 1].filter((v) => v >= 2 && v <= 20)) {
        out.push({
          type: c.type,
          params: { period, trendLookback: tl, maMode },
        });
      }
      return out;
    }
  }
}

function computeBestPerType(
  results: OptimizerResult[],
): Partial<Record<IndicatorType, OptimizerResult>> {
  const out: Partial<Record<IndicatorType, OptimizerResult>> = {};
  for (const r of results) {
    const current = out[r.type];
    if (!current || compareResults(r, current) < 0) {
      out[r.type] = r;
    }
  }
  return out;
}

function generateRefineCandidates(c: OptimizerCandidate): OptimizerCandidate[] {
  const out: OptimizerCandidate[] = [];
  switch (c.type) {
    case 'RSI': {
      const period = c.params.period ?? 14;
      const oversold = c.params.oversold ?? 30;
      const overbought = c.params.overbought ?? 70;
      for (const p of nearbyInt(period, 2, 2, 60)) {
        for (const os of nearbyInt(oversold, 3, 10, 45)) {
          for (const ob of nearbyInt(overbought, 3, 55, 90)) {
            if (os >= ob - 5) continue;
            out.push({
              type: 'RSI',
              params: { period: p, oversold: os, overbought: ob },
            });
          }
        }
      }
      return out;
    }
    case 'MACD': {
      const fastP = c.params.fastPeriod ?? 12;
      const slowP = c.params.slowPeriod ?? 26;
      const sigP = c.params.signalPeriod ?? 9;
      const mode = (c.params.macdMode ?? 'signal_cross') as MACDMode;
      for (const f of nearbyInt(fastP, 1, 3, 25)) {
        for (const s of nearbyInt(slowP, 2, 10, 60)) {
          if (f >= s) continue;
          for (const sg of nearbyInt(sigP, 1, 3, 20)) {
            out.push({
              type: 'MACD',
              params: {
                fastPeriod: f,
                slowPeriod: s,
                signalPeriod: sg,
                macdMode: mode,
              },
            });
          }
        }
      }
      return out;
    }
    case 'BBANDS': {
      const period = c.params.period ?? 20;
      const stdDev = c.params.stdDev ?? 2;
      const mode = (c.params.bbandsMode ?? 'mean_reversion') as BBandsMode;
      for (const p of nearbyInt(period, 2, 5, 60)) {
        for (const sd of nearbyFloat(stdDev, 0.25, 1, 4)) {
          out.push({
            type: 'BBANDS',
            params: { period: p, stdDev: sd, bbandsMode: mode },
          });
        }
      }
      return out;
    }
    case 'SMA':
    case 'EMA': {
      const period = c.params.period ?? 20;
      const trendLb = c.params.trendLookback ?? 5;
      const maMode = (c.params.maMode ?? 'price_cross') as MAMode;
      const periodStep = period >= 100 ? 10 : 5;
      for (const p of nearbyInt(period, periodStep, 3, 400)) {
        for (const tl of nearbyInt(trendLb, 1, 2, 20)) {
          out.push({
            type: c.type,
            params: { period: p, trendLookback: tl, maMode },
          });
        }
      }
      return out;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function candidateKey(c: OptimizerCandidate): string {
  return `${c.type}|${stableStringify(c.params as Record<string, unknown>)}`;
}

// Stable param key for de-duplication. We sort keys so JSON insertion order
// doesn't affect the cache key — important because the grids generate keys
// in different orders depending on which path produced them.
function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(
    Object.fromEntries(keys.map((k) => [k, obj[k]])),
  );
}

function nearbyInt(center: number, step: number, min: number, max: number): number[] {
  const set = new Set<number>([
    Math.max(min, Math.round(center - step)),
    Math.round(center),
    Math.min(max, Math.round(center + step)),
  ]);
  return Array.from(set);
}

function nearbyFloat(center: number, step: number, min: number, max: number): number[] {
  const round = (x: number) => Math.round(x * 100) / 100;
  const set = new Set<number>([
    round(Math.max(min, center - step)),
    round(center),
    round(Math.min(max, center + step)),
  ]);
  return Array.from(set);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Primary sort is by test-window return — that's literally what the user
 * asked the optimizer to maximise. Composite is a deterministic tiebreaker
 * so identical-return candidates land in stable order.
 */
function compareResults(a: OptimizerResult, b: OptimizerResult): number {
  if (b.outSampleReturnScore !== a.outSampleReturnScore) {
    return b.outSampleReturnScore - a.outSampleReturnScore;
  }
  return b.outSampleScore - a.outSampleScore;
}

function topK(results: OptimizerResult[], k: number): OptimizerResult[] {
  return [...results].sort(compareResults).slice(0, k);
}

function groupByType(
  results: OptimizerResult[],
): Partial<Record<IndicatorType, OptimizerResult[]>> {
  const out: Partial<Record<IndicatorType, OptimizerResult[]>> = {};
  for (const r of results) {
    if (!out[r.type]) out[r.type] = [];
    out[r.type]!.push(r);
  }
  return out;
}

function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
