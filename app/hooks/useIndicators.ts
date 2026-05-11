'use client';

import { useMemo } from 'react';
import { useAppStore } from '../store/store';
import {
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateSMA,
  calculateEMA,
} from '../lib/indicators';
import type { IndicatorValues } from '../lib/types';

const EMPTY: IndicatorValues = {
  rsi: null,
  macd: null,
  bbands: null,
  sma: [],
  ema: [],
};

export function useIndicators(): IndicatorValues {
  const candleData = useAppStore((s) => s.candleData);
  const indicators = useAppStore((s) => s.indicators);

  return useMemo(() => {
    if (!candleData || candleData.length === 0) return EMPTY;
    const closes = candleData.map((c) => c.close);
    const enabled = indicators.filter((i) => i.enabled);
    if (enabled.length === 0) return EMPTY;

    const out: IndicatorValues = {
      rsi: null,
      macd: null,
      bbands: null,
      sma: [],
      ema: [],
    };

    for (const ind of enabled) {
      try {
        if (ind.type === 'RSI') {
          out.rsi = calculateRSI(closes, ind.params.period ?? 14);
        } else if (ind.type === 'MACD') {
          out.macd = calculateMACD(
            closes,
            ind.params.fastPeriod ?? 12,
            ind.params.slowPeriod ?? 26,
            ind.params.signalPeriod ?? 9,
          );
        } else if (ind.type === 'BBANDS') {
          out.bbands = calculateBollingerBands(
            closes,
            ind.params.period ?? 20,
            ind.params.stdDev ?? 2,
          );
        } else if (ind.type === 'SMA') {
          const period = ind.params.period ?? 20;
          if (!out.sma.some((s) => s.period === period)) {
            out.sma.push({ period, values: calculateSMA(closes, period) });
          }
        } else if (ind.type === 'EMA') {
          const period = ind.params.period ?? 50;
          if (!out.ema.some((s) => s.period === period)) {
            out.ema.push({ period, values: calculateEMA(closes, period) });
          }
        }
      } catch (err) {
        console.error(`Indicator ${ind.type} calc failed:`, err);
      }
    }

    return out;
  }, [candleData, indicators]);
}
