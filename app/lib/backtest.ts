import type {
  BacktestPerformance,
  BacktestResult,
  BacktestSettings,
  Candle,
  CandlePosition,
  ChartSignal,
  IndicatorConfig,
  Strategy,
  StrategyCondition,
  Trade,
} from './types';
import {
  calculateBollingerBands,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateSMA,
  detectSeriesCross,
} from './indicators';

interface PrecomputedIndicators {
  rsi: Map<number, number[]>;
  ema: Map<number, number[]>;
  sma: Map<number, number[]>;
  macd: Map<string, { MACD: number[]; signal: number[]; histogram: number[] }>;
  bbands: Map<
    string,
    { upper: number[]; middle: number[]; lower: number[] }
  >;
}

function precompute(
  candles: Candle[],
  indicators: IndicatorConfig[],
): PrecomputedIndicators {
  const closes = candles.map((c) => c.close);
  const result: PrecomputedIndicators = {
    rsi: new Map(),
    ema: new Map(),
    sma: new Map(),
    macd: new Map(),
    bbands: new Map(),
  };

  for (const ind of indicators) {
    if (ind.type === 'RSI') {
      const period = ind.params.period ?? 14;
      if (!result.rsi.has(period)) {
        result.rsi.set(period, calculateRSI(closes, period));
      }
    }
    if (ind.type === 'EMA') {
      const period = ind.params.period ?? 50;
      if (!result.ema.has(period)) {
        result.ema.set(period, calculateEMA(closes, period));
      }
    }
    if (ind.type === 'SMA') {
      const period = ind.params.period ?? 20;
      if (!result.sma.has(period)) {
        result.sma.set(period, calculateSMA(closes, period));
      }
    }
    if (ind.type === 'MACD') {
      const fast = ind.params.fastPeriod ?? 12;
      const slow = ind.params.slowPeriod ?? 26;
      const sig = ind.params.signalPeriod ?? 9;
      const key = `${fast}-${slow}-${sig}`;
      if (!result.macd.has(key)) {
        result.macd.set(key, calculateMACD(closes, fast, slow, sig));
      }
    }
    if (ind.type === 'BBANDS') {
      const period = ind.params.period ?? 20;
      const std = ind.params.stdDev ?? 2;
      const key = `${period}-${std}`;
      if (!result.bbands.has(key)) {
        result.bbands.set(key, calculateBollingerBands(closes, period, std));
      }
    }
  }
  return result;
}

/** Right-aligned indicator value at candle index `i` (full candle array index). */
function valueAt(
  series: number[] | undefined,
  candleIndex: number,
  totalCandles: number,
): number {
  if (!series || series.length === 0) return NaN;
  const offset = totalCandles - series.length;
  const idx = candleIndex - offset;
  if (idx < 0 || idx >= series.length) return NaN;
  return series[idx];
}

interface ConditionContext {
  candle: Candle;
  prevCandle: Candle | null;
  candleIndex: number;
  total: number;
  pre: PrecomputedIndicators;
  indicators: IndicatorConfig[];
}

function resolveValue(
  cond: StrategyCondition,
  ctx: ConditionContext,
): { current: number; previous: number } {
  if (cond.indicator === 'PRICE') {
    return {
      current: ctx.candle.close,
      previous: ctx.prevCandle ? ctx.prevCandle.close : NaN,
    };
  }
  if (cond.indicator === 'RSI') {
    const ind = ctx.indicators.find((i) => i.type === 'RSI');
    const period = ind?.params.period ?? 14;
    const series = ctx.pre.rsi.get(period);
    return {
      current: valueAt(series, ctx.candleIndex, ctx.total),
      previous: valueAt(series, ctx.candleIndex - 1, ctx.total),
    };
  }
  if (cond.indicator === 'SMA') {
    const ind = ctx.indicators.find((i) => i.type === 'SMA');
    const period = ind?.params.period ?? 20;
    const series = ctx.pre.sma.get(period);
    return {
      current: valueAt(series, ctx.candleIndex, ctx.total),
      previous: valueAt(series, ctx.candleIndex - 1, ctx.total),
    };
  }
  if (cond.indicator === 'EMA') {
    const ind = ctx.indicators.find((i) => i.type === 'EMA');
    const period = ind?.params.period ?? 50;
    const series = ctx.pre.ema.get(period);
    return {
      current: valueAt(series, ctx.candleIndex, ctx.total),
      previous: valueAt(series, ctx.candleIndex - 1, ctx.total),
    };
  }
  if (cond.indicator === 'MACD') {
    const ind = ctx.indicators.find((i) => i.type === 'MACD');
    const fast = ind?.params.fastPeriod ?? 12;
    const slow = ind?.params.slowPeriod ?? 26;
    const sig = ind?.params.signalPeriod ?? 9;
    const key = `${fast}-${slow}-${sig}`;
    const macd = ctx.pre.macd.get(key);
    if (!macd) return { current: NaN, previous: NaN };
    const which =
      cond.param === 'signal'
        ? macd.signal
        : cond.param === 'histogram'
          ? macd.histogram
          : macd.MACD;
    return {
      current: valueAt(which, ctx.candleIndex, ctx.total),
      previous: valueAt(which, ctx.candleIndex - 1, ctx.total),
    };
  }
  if (cond.indicator === 'BBANDS') {
    const ind = ctx.indicators.find((i) => i.type === 'BBANDS');
    const period = ind?.params.period ?? 20;
    const std = ind?.params.stdDev ?? 2;
    const key = `${period}-${std}`;
    const bb = ctx.pre.bbands.get(key);
    if (!bb) return { current: NaN, previous: NaN };
    const which =
      cond.param === 'upper'
        ? bb.upper
        : cond.param === 'lower'
          ? bb.lower
          : bb.middle;
    return {
      current: valueAt(which, ctx.candleIndex, ctx.total),
      previous: valueAt(which, ctx.candleIndex - 1, ctx.total),
    };
  }
  return { current: NaN, previous: NaN };
}

function evaluateCondition(
  cond: StrategyCondition,
  ctx: ConditionContext,
): boolean {
  const { current, previous } = resolveValue(cond, ctx);
  if (!Number.isFinite(current)) return false;

  // The right-hand side: a literal number, or another indicator series
  let rhsCurr: number;
  let rhsPrev: number;
  if (cond.valueType === 'indicator' && typeof cond.value === 'string') {
    // For the RHS series, prefer `valueParam` (explicit RHS specifier);
    // fall back to `param` for back-compat with older condition shapes.
    const synthetic: StrategyCondition = {
      ...cond,
      indicator: cond.value as StrategyCondition['indicator'],
      param: cond.valueParam ?? cond.param,
      operator: '>',
      value: 0,
      valueType: 'number',
    };
    const r = resolveValue(synthetic, ctx);
    rhsCurr = r.current;
    rhsPrev = r.previous;
  } else {
    rhsCurr = Number(cond.value);
    rhsPrev = Number(cond.value);
  }
  if (!Number.isFinite(rhsCurr)) return false;

  switch (cond.operator) {
    case '>':
      return current > rhsCurr;
    case '<':
      return current < rhsCurr;
    case '>=':
      return current >= rhsCurr;
    case '<=':
      return current <= rhsCurr;
    case '==':
      return Math.abs(current - rhsCurr) < 1e-8;
    case 'crosses_above':
      return detectSeriesCross(previous, rhsPrev, current, rhsCurr) === 'above';
    case 'crosses_below':
      return detectSeriesCross(previous, rhsPrev, current, rhsCurr) === 'below';
    default:
      return false;
  }
}

function evaluateConditions(
  conds: StrategyCondition[],
  logic: 'AND' | 'OR',
  ctx: ConditionContext,
): boolean {
  if (conds.length === 0) return false;
  if (logic === 'AND') return conds.every((c) => evaluateCondition(c, ctx));
  return conds.some((c) => evaluateCondition(c, ctx));
}

/* -------------------------------------------------------------------------- */
/*                              Main entry point                              */
/* -------------------------------------------------------------------------- */

export function runBacktest(
  candles: Candle[],
  strategy: Strategy,
  settings: Pick<BacktestSettings, 'initialCapital' | 'commission'> & {
    symbol: string;
    timeframe: BacktestSettings['timeframe'];
  },
): BacktestResult {
  const initialCapital = settings.initialCapital;
  const commission = settings.commission;
  const pre = precompute(candles, strategy.indicators);

  let cash = initialCapital;
  let positionQty = 0;
  let positionEntryPrice = 0;
  const trades: Trade[] = [];
  const equity: { time: number; value: number }[] = [];
  let peak = initialCapital;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  const dailyReturns: number[] = [];
  let lastEquity = initialCapital;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const prev = i > 0 ? candles[i - 1] : null;
    const ctx: ConditionContext = {
      candle,
      prevCandle: prev,
      candleIndex: i,
      total: candles.length,
      pre,
      indicators: strategy.indicators,
    };

    const isLong = positionQty > 0;
    const buy = !isLong
      ? evaluateConditions(strategy.buyConditions, strategy.logic, ctx)
      : false;
    const sell = isLong
      ? evaluateConditions(strategy.sellConditions, strategy.logic, ctx)
      : false;

    if (buy) {
      const fee = cash * commission;
      const investable = cash - fee;
      const qty = investable / candle.close;
      positionQty = qty;
      positionEntryPrice = candle.close;
      cash = 0;
      trades.push({
        type: 'BUY',
        time: candle.time,
        price: candle.close,
        quantity: qty,
      });
    } else if (sell) {
      const proceeds = positionQty * candle.close;
      const fee = proceeds * commission;
      const net = proceeds - fee;
      const cost = positionQty * positionEntryPrice;
      const pnl = net - cost;
      const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
      cash = net;
      trades.push({
        type: 'SELL',
        time: candle.time,
        price: candle.close,
        quantity: positionQty,
        pnl,
        pnlPercent,
      });
      positionQty = 0;
      positionEntryPrice = 0;
    }

    const eq = cash + positionQty * candle.close;
    equity.push({ time: candle.time, value: eq });
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdownAbs) maxDrawdownAbs = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    if (lastEquity > 0) {
      dailyReturns.push((eq - lastEquity) / lastEquity);
    }
    lastEquity = eq;
  }

  // Force-close any open position at the last close
  if (positionQty > 0 && candles.length > 0) {
    const last = candles[candles.length - 1];
    const proceeds = positionQty * last.close;
    const fee = proceeds * commission;
    const net = proceeds - fee;
    const cost = positionQty * positionEntryPrice;
    const pnl = net - cost;
    const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
    cash = net;
    trades.push({
      type: 'SELL',
      time: last.time,
      price: last.close,
      quantity: positionQty,
      pnl,
      pnlPercent,
    });
    positionQty = 0;
  }

  const finalCapital = cash;
  const totalReturn = finalCapital - initialCapital;
  const totalReturnPercent =
    initialCapital > 0 ? (totalReturn / initialCapital) * 100 : 0;

  const closedTrades = trades.filter(
    (t): t is Trade & { pnl: number; pnlPercent: number } =>
      t.type === 'SELL' && t.pnl !== undefined,
  );
  const wins = closedTrades.filter((t) => t.pnl > 0);
  const losses = closedTrades.filter((t) => t.pnl <= 0);
  const winRate =
    closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const averageWin =
    wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const averageLoss =
    losses.length > 0
      ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length
      : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Sharpe ratio: annualized assuming 365 daily returns; here we use raw returns.
  const meanRet =
    dailyReturns.length > 0
      ? dailyReturns.reduce((s, x) => s + x, 0) / dailyReturns.length
      : 0;
  const variance =
    dailyReturns.length > 0
      ? dailyReturns.reduce((s, x) => s + (x - meanRet) ** 2, 0) /
        dailyReturns.length
      : 0;
  const stddev = Math.sqrt(variance);
  const sharpe =
    stddev > 0 ? (meanRet / stddev) * Math.sqrt(365) : 0;

  const performance: BacktestPerformance = {
    initialCapital,
    finalCapital,
    totalReturn,
    totalReturnPercent,
    winRate,
    numberOfTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    maxDrawdown: maxDrawdownAbs,
    maxDrawdownPercent: maxDrawdownPct,
    sharpeRatio: Number.isFinite(sharpe) ? sharpe : 0,
    averageWin,
    averageLoss,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 0,
  };

  return {
    symbol: settings.symbol,
    timeframe: settings.timeframe,
    startTime: candles.length > 0 ? candles[0].time : 0,
    endTime: candles.length > 0 ? candles[candles.length - 1].time : 0,
    trades,
    performance,
    equity,
  };
}

/**
 * Lightweight "what does this strategy say?" pass used to drive on-chart
 * signal markers. Mirrors `runBacktest`'s state machine (long/flat,
 * alternating buy↔sell) but skips portfolio accounting, fees, equity tracking,
 * and the force-close-at-end behaviour — none of which are meaningful when
 * we're just annotating the chart with the moment a rule fired.
 */
export function computeStrategySignals(
  candles: Candle[],
  strategy: Strategy,
): Array<{ time: number; type: 'BUY' | 'SELL' }> {
  if (candles.length === 0) return [];
  const pre = precompute(candles, strategy.indicators);
  const out: Array<{ time: number; type: 'BUY' | 'SELL' }> = [];
  let inLong = false;

  for (let i = 0; i < candles.length; i++) {
    const ctx: ConditionContext = {
      candle: candles[i],
      prevCandle: i > 0 ? candles[i - 1] : null,
      candleIndex: i,
      total: candles.length,
      pre,
      indicators: strategy.indicators,
    };

    const buy = !inLong
      ? evaluateConditions(strategy.buyConditions, strategy.logic, ctx)
      : false;
    const sell = inLong
      ? evaluateConditions(strategy.sellConditions, strategy.logic, ctx)
      : false;

    if (buy) {
      out.push({ time: candles[i].time, type: 'BUY' });
      inLong = true;
    } else if (sell) {
      out.push({ time: candles[i].time, type: 'SELL' });
      inLong = false;
    }
  }
  return out;
}

/**
 * Walks the candle sequence with a precomputed signal list and returns the
 * position state (`long` / `flat`) at every bar. Initial state is `flat`;
 * each BUY flips it to `long` from that candle onward, each SELL flips it
 * back to `flat`. Used by the chart's focused-indicator zone shading.
 */
export function computeCandlePositions(
  candles: Candle[],
  signals: ChartSignal[],
): CandlePosition[] {
  if (candles.length === 0) return [];
  const sigByTime = new Map<number, 'BUY' | 'SELL'>();
  for (const s of signals) sigByTime.set(s.time, s.type);
  const out: CandlePosition[] = [];
  let inLong = false;
  for (const c of candles) {
    const sig = sigByTime.get(c.time);
    if (sig === 'BUY') inLong = true;
    else if (sig === 'SELL') inLong = false;
    out.push({ time: c.time, state: inLong ? 'long' : 'flat' });
  }
  return out;
}

/**
 * Computes signals for each indicator independently, then merges by
 * (time, type) — when two indicators agree at the same candle we keep one
 * marker and attribute it to all sources.
 */
export function computeMultiIndicatorSignals(
  candles: Candle[],
  indicators: IndicatorConfig[],
  strategyFor: (ind: IndicatorConfig) => Strategy,
): ChartSignal[] {
  if (candles.length === 0 || indicators.length === 0) return [];
  const merged = new Map<string, ChartSignal>();
  for (const ind of indicators) {
    let signals: Array<{ time: number; type: 'BUY' | 'SELL' }>;
    try {
      const strategy = strategyFor(ind);
      signals = computeStrategySignals(candles, strategy);
    } catch (err) {
      console.warn(`Signal calc failed for ${ind.type}:`, err);
      continue;
    }
    for (const s of signals) {
      const key = `${s.time}|${s.type}`;
      if (!merged.has(key)) {
        merged.set(key, { time: s.time, type: s.type, source: ind.type });
      }
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.time - b.time);
}
