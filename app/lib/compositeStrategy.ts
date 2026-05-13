import {
  calculateBollingerBands,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateSMA,
} from './indicators';
import { getCachedKlines } from './klinesCache';
import type {
  BacktestPerformance,
  BacktestResult,
  Candle,
  CandlePosition,
  IndicatorConfig,
  Timeframe,
  Trade,
} from './types';

/**
 * Per-bar state "hint" from a single indicator. `longHint` is true on bars
 * where the indicator's BUY-side predicate evaluates true (e.g. RSI <
 * oversold, price < lower band, MACD > signal). `shortHint` mirrors that on
 * the SELL side. Most indicators are mutually exclusive (RSI can't be both
 * <30 and >70) but we don't enforce that — the composer just falls back to
 * "maintain current position" when both or neither are set.
 */
export interface BarHint {
  time: number;
  longHint: boolean;
  shortHint: boolean;
}

const DAY_MS = 86_400_000;

/* -------------------------------------------------------------------------- */
/*                Per-indicator hint computation (own timeframe)              */
/* -------------------------------------------------------------------------- */

/**
 * Build a per-bar long/short hint stream for one indicator, evaluated on the
 * caller-supplied candles (which should be that indicator's own timeframe,
 * not the chart's). All "is this state long-favourable?" predicates are
 * state-based — current value vs. threshold — not cross-event based, so the
 * AND combinator further down the pipeline actually has overlapping bars to
 * agree on.
 */
export function computeIndicatorHints(
  candles: Candle[],
  ind: IndicatorConfig,
): BarHint[] {
  if (candles.length === 0) return [];
  const closes = candles.map((c) => c.close);

  // Each branch fills `longArr` / `shortArr` aligned to the candles array
  // (NaN where the indicator hasn't accumulated enough samples yet).
  const longArr: boolean[] = new Array(candles.length).fill(false);
  const shortArr: boolean[] = new Array(candles.length).fill(false);

  switch (ind.type) {
    case 'RSI': {
      const period = ind.params.period ?? 14;
      const oversold = ind.params.oversold ?? 30;
      const overbought = ind.params.overbought ?? 70;
      const series = calculateRSI(closes, period);
      const offset = closes.length - series.length;
      for (let i = 0; i < series.length; i++) {
        const v = series[i];
        if (!Number.isFinite(v)) continue;
        longArr[i + offset] = v < oversold;
        shortArr[i + offset] = v > overbought;
      }
      break;
    }
    case 'MACD': {
      const fast = ind.params.fastPeriod ?? 12;
      const slow = ind.params.slowPeriod ?? 26;
      const sig = ind.params.signalPeriod ?? 9;
      const mode = ind.params.macdMode ?? 'signal_cross';
      const { MACD, signal, histogram } = calculateMACD(closes, fast, slow, sig);
      const offsetMacd = closes.length - MACD.length;
      const offsetSignal = closes.length - signal.length;
      const offsetHist = closes.length - histogram.length;
      for (let i = 0; i < candles.length; i++) {
        if (mode === 'signal_cross') {
          const m = MACD[i - offsetMacd];
          const s = signal[i - offsetSignal];
          if (Number.isFinite(m) && Number.isFinite(s)) {
            longArr[i] = m > s;
            shortArr[i] = m < s;
          }
        } else if (mode === 'zero_cross') {
          const m = MACD[i - offsetMacd];
          if (Number.isFinite(m)) {
            longArr[i] = m > 0;
            shortArr[i] = m < 0;
          }
        } else {
          // histogram_sign
          const h = histogram[i - offsetHist];
          if (Number.isFinite(h)) {
            longArr[i] = h > 0;
            shortArr[i] = h < 0;
          }
        }
      }
      break;
    }
    case 'BBANDS': {
      const period = ind.params.period ?? 20;
      const stdDev = ind.params.stdDev ?? 2;
      const mode = ind.params.bbandsMode ?? 'mean_reversion';
      const { upper, lower } = calculateBollingerBands(closes, period, stdDev);
      const offsetU = closes.length - upper.length;
      const offsetL = closes.length - lower.length;
      for (let i = 0; i < candles.length; i++) {
        const u = upper[i - offsetU];
        const l = lower[i - offsetL];
        const price = candles[i].close;
        if (Number.isFinite(u) && Number.isFinite(l)) {
          if (mode === 'mean_reversion') {
            longArr[i] = price < l;
            shortArr[i] = price > u;
          } else {
            // breakout
            longArr[i] = price > u;
            shortArr[i] = price < l;
          }
        }
      }
      break;
    }
    case 'SMA':
    case 'EMA': {
      const period = ind.params.period ?? 20;
      const series =
        ind.type === 'SMA'
          ? calculateSMA(closes, period)
          : calculateEMA(closes, period);
      const offset = closes.length - series.length;
      for (let i = 0; i < series.length; i++) {
        const ma = series[i];
        if (!Number.isFinite(ma)) continue;
        const price = candles[i + offset].close;
        longArr[i + offset] = price > ma;
        shortArr[i + offset] = price < ma;
      }
      break;
    }
  }

  return candles.map((c, i) => ({
    time: c.time,
    longHint: longArr[i],
    shortHint: shortArr[i],
  }));
}

/* -------------------------------------------------------------------------- */
/*                Projection: indicator timeframe → chart bars                */
/* -------------------------------------------------------------------------- */

/**
 * For each chart bar, carry the most-recent indicator-tf hint whose bar
 * timestamp is ≤ the chart bar's timestamp. Chart bars older than the
 * indicator's earliest sample get neutral hints (false / false) — when the
 * indicator has no opinion the AND composer can't reach consensus, so no
 * trade fires there.
 */
export function projectHintsOntoChart(
  indHints: BarHint[],
  chartCandles: Candle[],
): BarHint[] {
  if (chartCandles.length === 0) return [];
  if (indHints.length === 0) {
    return chartCandles.map((c) => ({
      time: c.time,
      longHint: false,
      shortHint: false,
    }));
  }
  const sorted = [...indHints].sort((a, b) => a.time - b.time);
  let idx = 0;
  let current: BarHint | null = null;
  const out: BarHint[] = [];
  for (const c of chartCandles) {
    while (idx < sorted.length && sorted[idx].time <= c.time) {
      current = sorted[idx];
      idx++;
    }
    out.push({
      time: c.time,
      longHint: current?.longHint ?? false,
      shortHint: current?.shortHint ?? false,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                            Composite combinator                            */
/* -------------------------------------------------------------------------- */

export function combineHints(
  perIndicatorHints: BarHint[][],
  logic: 'AND' | 'OR',
): BarHint[] {
  if (perIndicatorHints.length === 0) return [];
  const n = perIndicatorHints[0].length;
  const out: BarHint[] = [];
  for (let i = 0; i < n; i++) {
    const longs = perIndicatorHints.map((p) => p[i]?.longHint ?? false);
    const shorts = perIndicatorHints.map((p) => p[i]?.shortHint ?? false);
    const compositeLong =
      logic === 'AND' ? longs.every((v) => v) : longs.some((v) => v);
    const compositeShort =
      logic === 'AND' ? shorts.every((v) => v) : shorts.some((v) => v);
    out.push({
      time: perIndicatorHints[0][i].time,
      longHint: compositeLong,
      shortHint: compositeShort,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                        End-to-end hint pipeline                            */
/* -------------------------------------------------------------------------- */

/**
 * Fetches each indicator's own-timeframe candles, computes its state hints,
 * projects them onto the chart bars, and combines via AND or OR. Per-
 * indicator failures degrade gracefully — the indicator just contributes
 * neutral hints (no vote) rather than aborting the whole pipeline.
 */
export async function computeCompositeHints(args: {
  chartCandles: Candle[];
  indicators: IndicatorConfig[];
  logic: 'AND' | 'OR';
  symbol: string;
  cryptoUniverse: ReadonlySet<string>;
}): Promise<BarHint[]> {
  const { chartCandles, indicators, logic, symbol, cryptoUniverse } = args;
  if (chartCandles.length === 0 || indicators.length === 0) return [];

  const firstSec = chartCandles[0].time;
  const lastMs = chartCandles[chartCandles.length - 1].time * 1000;
  const startMs = firstSec * 1000;
  // Fetch enough indicator-tf data to span the chart range. Cap at 3 years
  // so a 1d chart × 1500 bars (~4 yr) doesn't try to pull every 5m candle
  // since the dawn of the pair.
  const rangeMs = Math.min(3 * 365 * DAY_MS, Math.max(60 * DAY_MS, lastMs - startMs));

  const perIndicator = await Promise.all(
    indicators.map(async (ind) => {
      try {
        const indCandles = await getCachedKlines(
          symbol,
          ind.timeframe,
          rangeMs,
          cryptoUniverse,
        );
        const hints = computeIndicatorHints(indCandles, ind);
        return projectHintsOntoChart(hints, chartCandles);
      } catch (err) {
        console.warn(
          `composite: failed to fetch ${symbol}@${ind.timeframe} for ${ind.type}`,
          err,
        );
        return chartCandles.map((c) => ({
          time: c.time,
          longHint: false,
          shortHint: false,
        }));
      }
    }),
  );

  return combineHints(perIndicator, logic);
}

/* -------------------------------------------------------------------------- */
/*                           Derivations from hints                           */
/* -------------------------------------------------------------------------- */

/**
 * Buy/sell transitions implied by the hint stream. Long-short semantics:
 * a `longHint`-only bar means "be long"; a `shortHint`-only bar means
 * "be short"; anything else holds the current side.
 */
export function signalsFromHints(
  hints: BarHint[],
): Array<{ time: number; type: 'BUY' | 'SELL' }> {
  const out: Array<{ time: number; type: 'BUY' | 'SELL' }> = [];
  let side: -1 | 0 | 1 = 0;
  for (const h of hints) {
    let target: -1 | 0 | 1 = side;
    if (h.longHint && !h.shortHint) target = 1;
    else if (h.shortHint && !h.longHint) target = -1;
    if (target !== side) {
      out.push({ time: h.time, type: target === 1 ? 'BUY' : 'SELL' });
      side = target;
    }
  }
  return out;
}

/**
 * Project hints into the long/flat zone series the chart consumes.
 * `short` collapses to `flat` because the chart only renders two colours;
 * red still reads correctly as "out of long".
 */
export function zonesFromHints(hints: BarHint[]): CandlePosition[] {
  const out: CandlePosition[] = [];
  let side: 'long' | 'flat' = 'flat';
  for (const h of hints) {
    if (h.longHint && !h.shortHint) side = 'long';
    else if (h.shortHint && !h.longHint) side = 'flat';
    out.push({ time: h.time, state: side });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                         Full backtest from hints                           */
/* -------------------------------------------------------------------------- */

/**
 * Long-short simulation driven entirely by hint-derived position targets.
 * Mirrors `runBacktest`'s portfolio bookkeeping (fees, MTM equity for shorts,
 * force-close at end) but skips the strategy-condition machinery — the
 * decision of what side to be on this bar has already been made upstream.
 */
export function simulateBacktestFromHints(
  chartCandles: Candle[],
  hints: BarHint[],
  options: {
    symbol: string;
    timeframe: Timeframe;
    initialCapital: number;
    commission: number;
  },
): BacktestResult {
  const { initialCapital, commission, symbol, timeframe } = options;
  let cash = initialCapital;
  let positionSide: number = 0; // -1 short / 0 flat / 1 long
  let positionQty = 0;
  let positionEntryPrice = 0;
  const trades: Trade[] = [];
  const equity: { time: number; value: number }[] = [];
  let peak = initialCapital;
  let maxDdAbs = 0;
  let maxDdPct = 0;
  const periodReturns: number[] = [];
  let lastEquity = initialCapital;

  const closeLong = (exit: number) => {
    const proceeds = positionQty * exit;
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
  const closeShort = (exit: number) => {
    const exitFee = positionQty * exit * commission;
    const pnl = (positionEntryPrice - exit) * positionQty - exitFee;
    const cost = positionQty * positionEntryPrice;
    const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
    cash += pnl;
    positionQty = 0;
    positionSide = 0;
    positionEntryPrice = 0;
    return { pnl, pnlPercent };
  };
  const openLong = (entry: number) => {
    const fee = cash * commission;
    const investable = cash - fee;
    const qty = investable / entry;
    positionQty = qty;
    positionEntryPrice = entry;
    positionSide = 1;
    cash = 0;
    return qty;
  };
  const openShort = (entry: number) => {
    const fee = cash * commission;
    const notional = cash - fee;
    const qty = notional / entry;
    positionQty = qty;
    positionEntryPrice = entry;
    positionSide = -1;
    cash -= fee;
    return qty;
  };

  for (let i = 0; i < chartCandles.length; i++) {
    const candle = chartCandles[i];
    const h = hints[i];

    // Determine target side for this bar. Mixed / neutral hints maintain
    // the current side (no whipsaw when one indicator drops out briefly).
    let target = positionSide;
    if (h && h.longHint && !h.shortHint) target = 1;
    else if (h && h.shortHint && !h.longHint) target = -1;

    if (target !== positionSide) {
      let closedPnl: number | undefined;
      let closedPnlPct: number | undefined;
      if (positionSide === 1) {
        const r = closeLong(candle.close);
        closedPnl = r.pnl;
        closedPnlPct = r.pnlPercent;
      } else if (positionSide === -1) {
        const r = closeShort(candle.close);
        closedPnl = r.pnl;
        closedPnlPct = r.pnlPercent;
      }

      if (target === 1) {
        const qty = openLong(candle.close);
        trades.push({
          type: 'BUY',
          time: candle.time,
          price: candle.close,
          quantity: qty,
          ...(closedPnl !== undefined && {
            pnl: closedPnl,
            pnlPercent: closedPnlPct,
          }),
        });
      } else if (target === -1) {
        const qty = openShort(candle.close);
        trades.push({
          type: 'SELL',
          time: candle.time,
          price: candle.close,
          quantity: qty,
          ...(closedPnl !== undefined && {
            pnl: closedPnl,
            pnlPercent: closedPnlPct,
          }),
        });
      } else if (closedPnl !== undefined) {
        // target === 0 (flat) — record the closing trade so stats see it.
        trades.push({
          type: 'SELL',
          time: candle.time,
          price: candle.close,
          quantity: 0,
          pnl: closedPnl,
          pnlPercent: closedPnlPct,
        });
      }
    }

    let eq: number;
    if (positionSide === 1) eq = cash + positionQty * candle.close;
    else if (positionSide === -1)
      eq = cash + (positionEntryPrice - candle.close) * positionQty;
    else eq = cash;

    equity.push({ time: candle.time, value: eq });
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDdAbs) maxDdAbs = dd;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    if (lastEquity > 0) periodReturns.push((eq - lastEquity) / lastEquity);
    lastEquity = eq;
  }

  // Force-close any open position at the last bar so realised P&L feeds
  // into the stats.
  if (positionSide !== 0 && chartCandles.length > 0) {
    const last = chartCandles[chartCandles.length - 1];
    const qtyAtClose = positionQty;
    if (positionSide === 1) {
      const r = closeLong(last.close);
      trades.push({
        type: 'SELL',
        time: last.time,
        price: last.close,
        quantity: qtyAtClose,
        pnl: r.pnl,
        pnlPercent: r.pnlPercent,
      });
    } else {
      const r = closeShort(last.close);
      trades.push({
        type: 'BUY',
        time: last.time,
        price: last.close,
        quantity: qtyAtClose,
        pnl: r.pnl,
        pnlPercent: r.pnlPercent,
      });
    }
  }

  const finalCapital = cash;
  const totalReturn = finalCapital - initialCapital;
  const totalReturnPercent =
    initialCapital > 0 ? (totalReturn / initialCapital) * 100 : 0;

  const closedTrades = trades.filter(
    (t): t is Trade & { pnl: number; pnlPercent: number } =>
      t.pnl !== undefined,
  );
  const wins = closedTrades.filter((t) => t.pnl > 0);
  const losses = closedTrades.filter((t) => t.pnl <= 0);
  const winRate =
    closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor =
    grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? Infinity
        : 0;
  const meanRet =
    periodReturns.length > 0
      ? periodReturns.reduce((s, x) => s + x, 0) / periodReturns.length
      : 0;
  const variance =
    periodReturns.length > 0
      ? periodReturns.reduce((s, x) => s + (x - meanRet) ** 2, 0) /
        periodReturns.length
      : 0;
  const stddev = Math.sqrt(variance);
  const sharpe = stddev > 0 ? (meanRet / stddev) * Math.sqrt(365) : 0;

  const performance: BacktestPerformance = {
    initialCapital,
    finalCapital,
    totalReturn,
    totalReturnPercent,
    winRate,
    numberOfTrades: closedTrades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    maxDrawdown: maxDdAbs,
    maxDrawdownPercent: maxDdPct,
    sharpeRatio: Number.isFinite(sharpe) ? sharpe : 0,
    averageWin: wins.length > 0 ? grossProfit / wins.length : 0,
    averageLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 0,
  };

  return {
    symbol,
    timeframe,
    startTime: chartCandles.length > 0 ? chartCandles[0].time : 0,
    endTime: chartCandles.length > 0 ? chartCandles[chartCandles.length - 1].time : 0,
    trades,
    performance,
    equity,
  };
}
