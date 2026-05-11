/**
 * Pure-JS technical indicator wrappers built on top of `technicalindicators`.
 * The lib runs both in browser and Node — no native dependency.
 *
 * NOTE on alignment: indicators with a `period` of N return values starting at
 * candle N-1 (i.e. their length is `closes.length - period + 1`). Consumers
 * should right-align the output array to the END of the candle range.
 */

import {
  RSI,
  MACD,
  BollingerBands,
  SMA,
  EMA,
} from 'technicalindicators';

export function calculateRSI(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  return RSI.calculate({ values: closes, period });
}

export interface MACDResult {
  MACD: number[];
  signal: number[];
  histogram: number[];
}

export function calculateMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult {
  if (closes.length < slowPeriod + signalPeriod) {
    return { MACD: [], signal: [], histogram: [] };
  }
  const raw = MACD.calculate({
    values: closes,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const out: MACDResult = { MACD: [], signal: [], histogram: [] };
  for (const r of raw) {
    out.MACD.push(typeof r.MACD === 'number' ? r.MACD : NaN);
    out.signal.push(typeof r.signal === 'number' ? r.signal : NaN);
    out.histogram.push(typeof r.histogram === 'number' ? r.histogram : NaN);
  }
  return out;
}

export interface BBResult {
  upper: number[];
  middle: number[];
  lower: number[];
}

export function calculateBollingerBands(
  closes: number[],
  period = 20,
  stdDev = 2,
): BBResult {
  if (closes.length < period) return { upper: [], middle: [], lower: [] };
  const raw = BollingerBands.calculate({ values: closes, period, stdDev });
  return {
    upper: raw.map((r) => r.upper),
    middle: raw.map((r) => r.middle),
    lower: raw.map((r) => r.lower),
  };
}

export function calculateSMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  return SMA.calculate({ values: closes, period });
}

export function calculateEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  return EMA.calculate({ values: closes, period });
}

/**
 * Detect a value crossing above/below a threshold given the latest two readings.
 * Returns 'above' / 'below' / null.
 */
export function detectCrossover(
  prev: number,
  curr: number,
  threshold: number,
): 'above' | 'below' | null {
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return null;
  if (prev <= threshold && curr > threshold) return 'above';
  if (prev >= threshold && curr < threshold) return 'below';
  return null;
}

/** Detect when series A crosses above/below series B (e.g. MACD crossing signal). */
export function detectSeriesCross(
  prevA: number,
  prevB: number,
  currA: number,
  currB: number,
): 'above' | 'below' | null {
  if (
    !Number.isFinite(prevA) ||
    !Number.isFinite(prevB) ||
    !Number.isFinite(currA) ||
    !Number.isFinite(currB)
  ) {
    return null;
  }
  if (prevA <= prevB && currA > currB) return 'above';
  if (prevA >= prevB && currA < currB) return 'below';
  return null;
}
