import type {
  BacktestDirection,
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
    direction?: BacktestDirection;
  },
): BacktestResult {
  const initialCapital = settings.initialCapital;
  const commission = settings.commission;
  const direction: BacktestDirection = settings.direction ?? 'long-only';
  const allowShort = direction === 'long-short';
  const pre = precompute(candles, strategy.indicators);

  let cash = initialCapital;
  // -1 = short, 0 = flat, 1 = long. Typed as plain number so TS doesn't
  // narrow it after a literal initialiser — the helper functions below
  // mutate this value and the compiler can't track that across calls.
  let positionSide: number = 0;
  let positionQty = 0;
  let positionEntryPrice = 0;
  const trades: Trade[] = [];
  const equity: { time: number; value: number }[] = [];
  let peak = initialCapital;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  const dailyReturns: number[] = [];
  let lastEquity = initialCapital;

  const closeLong = (exitPrice: number): { pnl: number; pnlPercent: number } => {
    const proceeds = positionQty * exitPrice;
    const fee = proceeds * commission;
    const net = proceeds - fee;
    const cost = positionQty * positionEntryPrice;
    const pnl = net - cost;
    const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
    cash = net;
    positionQty = 0;
    positionSide = 0;
    positionEntryPrice = 0;
    return { pnl, pnlPercent };
  };

  const closeShort = (exitPrice: number): { pnl: number; pnlPercent: number } => {
    // Equity proxy for shorts: cash stayed parked at the open-time level
    // (no proceeds credited) and we settle the difference here. Treats the
    // short as a fully-collateralised bet rather than a leveraged margin
    // trade — close enough for ranking strategies in a backtest.
    const exitFee = positionQty * exitPrice * commission;
    const pnl = (positionEntryPrice - exitPrice) * positionQty - exitFee;
    const cost = positionQty * positionEntryPrice;
    const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
    cash += pnl;
    positionQty = 0;
    positionSide = 0;
    positionEntryPrice = 0;
    return { pnl, pnlPercent };
  };

  const openLong = (entryPrice: number) => {
    const fee = cash * commission;
    const investable = cash - fee;
    const qty = investable / entryPrice;
    positionQty = qty;
    positionEntryPrice = entryPrice;
    positionSide = 1;
    cash = 0;
    return qty;
  };

  const openShort = (entryPrice: number) => {
    const fee = cash * commission;
    const notional = cash - fee;
    const qty = notional / entryPrice;
    positionQty = qty;
    positionEntryPrice = entryPrice;
    positionSide = -1;
    cash -= fee; // pay opening fee; remaining cash sits as the margin reserve
    return qty;
  };

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

    // Signal eligibility per direction mode. In long-only, BUY only when
    // flat and SELL only when long — same state machine as before. In
    // long-short the side flips on every actionable signal so we evaluate
    // BUY whenever we're not already long and SELL whenever we're not
    // already short.
    const canBuy = allowShort ? positionSide !== 1 : positionSide === 0;
    const canSell = allowShort ? positionSide !== -1 : positionSide === 1;

    const buy = canBuy
      ? evaluateConditions(strategy.buyConditions, strategy.logic, ctx)
      : false;
    const sell = canSell
      ? evaluateConditions(strategy.sellConditions, strategy.logic, ctx)
      : false;

    if (buy) {
      // Close any open short first, then enter long. PnL on the BUY trade
      // record reflects the realised short profit (if any).
      let closedPnl: number | undefined;
      let closedPnlPct: number | undefined;
      if (positionSide === -1) {
        const r = closeShort(candle.close);
        closedPnl = r.pnl;
        closedPnlPct = r.pnlPercent;
      }
      const qty = openLong(candle.close);
      trades.push({
        type: 'BUY',
        time: candle.time,
        price: candle.close,
        quantity: qty,
        ...(closedPnl !== undefined && { pnl: closedPnl, pnlPercent: closedPnlPct }),
      });
    } else if (sell) {
      let closedPnl: number | undefined;
      let closedPnlPct: number | undefined;
      if (positionSide === 1) {
        const r = closeLong(candle.close);
        closedPnl = r.pnl;
        closedPnlPct = r.pnlPercent;
      }
      if (allowShort) {
        const qty = openShort(candle.close);
        trades.push({
          type: 'SELL',
          time: candle.time,
          price: candle.close,
          quantity: qty,
          ...(closedPnl !== undefined && { pnl: closedPnl, pnlPercent: closedPnlPct }),
        });
      } else {
        // long-only: SELL just exits to cash, with the realised long PnL
        trades.push({
          type: 'SELL',
          time: candle.time,
          price: candle.close,
          quantity: 0,
          pnl: closedPnl ?? 0,
          pnlPercent: closedPnlPct ?? 0,
        });
      }
    }

    // Mark-to-market equity.
    let eq: number;
    if (positionSide === 1) eq = cash + positionQty * candle.close;
    else if (positionSide === -1)
      eq = cash + (positionEntryPrice - candle.close) * positionQty;
    else eq = cash;

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

  // Force-close anything still open so realised PnL flows into final stats.
  if (positionSide !== 0 && candles.length > 0) {
    const last = candles[candles.length - 1];
    const qtyAtClose = positionQty;
    let pnl = 0;
    let pnlPct = 0;
    if (positionSide === 1) {
      const r = closeLong(last.close);
      pnl = r.pnl;
      pnlPct = r.pnlPercent;
      trades.push({
        type: 'SELL',
        time: last.time,
        price: last.close,
        quantity: qtyAtClose,
        pnl,
        pnlPercent: pnlPct,
      });
    } else {
      const r = closeShort(last.close);
      pnl = r.pnl;
      pnlPct = r.pnlPercent;
      trades.push({
        type: 'BUY',
        time: last.time,
        price: last.close,
        quantity: qtyAtClose,
        pnl,
        pnlPercent: pnlPct,
      });
    }
  }

  const finalCapital = cash;
  const totalReturn = finalCapital - initialCapital;
  const totalReturnPercent =
    initialCapital > 0 ? (totalReturn / initialCapital) * 100 : 0;

  // Any trade carrying a realised pnl counts as a closed round-trip — in
  // long-short mode this includes BUY trades that closed a prior short
  // alongside the usual SELLs that closed a long.
  const closedTrades = trades.filter(
    (t): t is Trade & { pnl: number; pnlPercent: number } =>
      t.pnl !== undefined,
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
    // Count closed round-trips, not raw signal events. In long-short mode
    // the very first signal only opens (no pnl yet) and would otherwise
    // inflate the count without contributing to win-rate.
    numberOfTrades: closedTrades.length,
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

/* -------------------------------------------------------------------------- */
/*                       Sub-range performance extraction                     */
/* -------------------------------------------------------------------------- */

function emptyPerformance(): BacktestPerformance {
  return {
    initialCapital: 0,
    finalCapital: 0,
    totalReturn: 0,
    totalReturnPercent: 0,
    winRate: 0,
    numberOfTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    sharpeRatio: 0,
    averageWin: 0,
    averageLoss: 0,
    profitFactor: 0,
  };
}

/**
 * Computes performance stats over a slice of an already-run backtest. Use
 * this when you want to ask "how did this strategy do between time A and
 * time B?" without re-running the engine — important because re-running a
 * sub-window from a flat start gives different results than letting the
 * state evolve continuously through earlier history.
 *
 * This is what makes the optimizer's "last month" return match the
 * indicator-performance-card's Monthly stat: both rely on a single
 * continuous backtest and filter the same way.
 */
export function computePerformanceInRange(
  result: BacktestResult,
  startSec: number,
  endSec: number,
): BacktestPerformance {
  const trades = result.trades.filter(
    (t) => t.time >= startSec && t.time <= endSec,
  );
  const equity = result.equity.filter(
    (e) => e.time >= startSec && e.time <= endSec,
  );
  if (equity.length < 2) return emptyPerformance();

  const startEq = equity[0].value;
  const endEq = equity[equity.length - 1].value;
  const totalReturn = endEq - startEq;
  const totalReturnPercent = startEq > 0 ? (totalReturn / startEq) * 100 : 0;

  const closed = trades.filter(
    (t): t is Trade & { pnl: number; pnlPercent: number } =>
      t.pnl !== undefined,
  );
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

  // Drawdown rebased to the start of the slice — a drawdown that bottomed
  // before our window starts shouldn't count against us here.
  let peak = startEq;
  let maxDdAbs = 0;
  let maxDdPct = 0;
  for (const e of equity) {
    if (e.value > peak) peak = e.value;
    const dd = peak - e.value;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDdAbs) maxDdAbs = dd;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  }

  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].value;
    if (prev > 0) returns.push((equity[i].value - prev) / prev);
  }
  const meanRet =
    returns.length > 0 ? returns.reduce((s, x) => s + x, 0) / returns.length : 0;
  const variance =
    returns.length > 0
      ? returns.reduce((s, x) => s + (x - meanRet) ** 2, 0) / returns.length
      : 0;
  const stddev = Math.sqrt(variance);
  const sharpe = stddev > 0 ? (meanRet / stddev) * Math.sqrt(365) : 0;

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor =
    grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? Infinity
        : 0;

  return {
    initialCapital: startEq,
    finalCapital: endEq,
    totalReturn,
    totalReturnPercent,
    winRate,
    numberOfTrades: closed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    maxDrawdown: maxDdAbs,
    maxDrawdownPercent: maxDdPct,
    sharpeRatio: Number.isFinite(sharpe) ? sharpe : 0,
    averageWin: wins.length > 0 ? grossProfit / wins.length : 0,
    averageLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 0,
  };
}

/**
 * Lightweight "what does this strategy say?" pass used to drive on-chart
 * signal markers. Mirrors `runBacktest`'s state machine but skips portfolio
 * accounting, fees, equity tracking, and the force-close-at-end behaviour —
 * none of which are meaningful when we're just annotating the chart with the
 * moment a rule fired.
 *
 * In `long-short` mode the state alternates between long and short (no flat
 * stretches once trading starts), so SELL signals can fire even when no
 * prior long position was open — the strategy is interpreting "rule said
 * SELL" as "be short here".
 */
export function computeStrategySignals(
  candles: Candle[],
  strategy: Strategy,
  direction: BacktestDirection = 'long-only',
): Array<{ time: number; type: 'BUY' | 'SELL' }> {
  if (candles.length === 0) return [];
  const pre = precompute(candles, strategy.indicators);
  const out: Array<{ time: number; type: 'BUY' | 'SELL' }> = [];
  const allowShort = direction === 'long-short';
  let side: -1 | 0 | 1 = 0;

  for (let i = 0; i < candles.length; i++) {
    const ctx: ConditionContext = {
      candle: candles[i],
      prevCandle: i > 0 ? candles[i - 1] : null,
      candleIndex: i,
      total: candles.length,
      pre,
      indicators: strategy.indicators,
    };

    const canBuy = allowShort ? side !== 1 : side === 0;
    const canSell = allowShort ? side !== -1 : side === 1;

    const buy = canBuy
      ? evaluateConditions(strategy.buyConditions, strategy.logic, ctx)
      : false;
    const sell = canSell
      ? evaluateConditions(strategy.sellConditions, strategy.logic, ctx)
      : false;

    if (buy) {
      out.push({ time: candles[i].time, type: 'BUY' });
      side = 1;
    } else if (sell) {
      out.push({ time: candles[i].time, type: 'SELL' });
      side = allowShort ? -1 : 0;
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
  direction: BacktestDirection = 'long-only',
): ChartSignal[] {
  if (candles.length === 0 || indicators.length === 0) return [];
  const merged = new Map<string, ChartSignal>();
  for (const ind of indicators) {
    let signals: Array<{ time: number; type: 'BUY' | 'SELL' }>;
    try {
      const strategy = strategyFor(ind);
      signals = computeStrategySignals(candles, strategy, direction);
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
