'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/store';
import Chart from './Chart';
import {
  computeMultiIndicatorSignals,
  computeStrategySignals,
} from '../lib/backtest';
import { defaultStrategyFor } from '../lib/indicatorStrategies';
import { precisionFallback } from '../lib/marketData';
import { getCachedKlines } from '../lib/klinesCache';
import type {
  Candle,
  CandlePosition,
  ChartSignal,
  IndicatorValues,
} from '../lib/types';

interface Props {
  indicatorValues: IndicatorValues;
}

/**
 * How far back to fetch indicator-timeframe candles so the chart's full
 * visible time range carries zone shading. Capped at 2 years to keep the
 * Binance request count bounded for sub-daily indicator timeframes.
 */
const MAX_INDICATOR_RANGE_MS = 2 * 365 * 86_400_000;
const FOCUS_REFRESH_INTERVAL_MS = 30_000;

export default function ChartContainer({ indicatorValues }: Props) {
  const candleData = useAppStore((s) => s.candleData);
  const indicators = useAppStore((s) => s.indicators);
  const lastBacktest = useAppStore((s) => s.lastBacktest);
  const isLoadingHistory = useAppStore((s) => s.isLoadingHistory);
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const timeframe = useAppStore((s) => s.timeframe);
  const focusedIndicatorId = useAppStore((s) => s.focusedIndicatorId);
  const symbolPrecisions = useAppStore((s) => s.symbolPrecisions);
  const allSymbols = useAppStore((s) => s.allSymbols);

  // Only indicators flagged for chart overlay produce live signal markers in
  // the default ("show everything") mode. In focus mode the highlighted
  // indicator is the sole signal source — and its signals come from its own
  // timeframe data, mapped onto whatever timeframe the chart is showing.
  const enabledIndicators = useMemo(
    () => indicators.filter((i) => i.enabled),
    [indicators],
  );

  const focusedIndicator = useMemo(
    () =>
      focusedIndicatorId
        ? indicators.find((i) => i.id === focusedIndicatorId) ?? null
        : null,
    [indicators, focusedIndicatorId],
  );

  const candleCount = candleData.length;
  const lastCandleTime = candleData[candleData.length - 1]?.time ?? 0;
  const firstCandleTime = candleData[0]?.time ?? 0;
  const indicatorsFingerprint = useMemo(
    () =>
      enabledIndicators
        .map((i) => `${i.id}:${i.type}:${JSON.stringify(i.params)}`)
        .join('|'),
    [enabledIndicators],
  );
  const focusFingerprint = useMemo(
    () =>
      focusedIndicator
        ? `${focusedIndicator.id}:${focusedIndicator.type}:${focusedIndicator.timeframe}:${JSON.stringify(focusedIndicator.params)}`
        : '',
    [focusedIndicator],
  );

  // ---- Non-focus signals: synchronous, computed from chart-tf candles ----
  const multiSignals: ChartSignal[] = useMemo(() => {
    if (candleCount === 0 || enabledIndicators.length === 0 || focusedIndicator) {
      return [];
    }
    return computeMultiIndicatorSignals(
      candleData,
      enabledIndicators,
      defaultStrategyFor,
      'long-short',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleCount, lastCandleTime, indicatorsFingerprint, focusFingerprint]);

  // ---- Focus zones: async, computed from indicator-tf candles. The zone
  // bands behind the candles communicate the long/flat cadence on their own,
  // so we deliberately drop the small green/red signal circles in focus mode
  // — they would just clutter the already-coloured backdrop.
  const [focusOverlay, setFocusOverlay] = useState<{
    zones: CandlePosition[] | undefined;
  }>({ zones: undefined });

  // Periodic refresh so signals stay live even when the chart-tf doesn't
  // produce new bars (e.g. weekly chart, 4h indicator).
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!focusedIndicator) return;
    const id = setInterval(
      () => setRefreshTick((t) => t + 1),
      FOCUS_REFRESH_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, [focusedIndicator]);

  useEffect(() => {
    if (!focusedIndicator || candleCount === 0) {
      setFocusOverlay({ zones: undefined });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const cryptoUniverse = new Set(allSymbols);
        const startMs = firstCandleTime * 1000;
        const rangeMs = Math.min(
          MAX_INDICATOR_RANGE_MS,
          Math.max(86_400_000, Date.now() - startMs),
        );
        const indCandles = await getCachedKlines(
          selectedSymbol,
          focusedIndicator.timeframe,
          rangeMs,
          cryptoUniverse,
        );
        if (cancelled) return;

        const strategy = defaultStrategyFor(focusedIndicator);
        const rawSignals = computeStrategySignals(
          indCandles,
          strategy,
          'long-short',
        );
        const indSignals: ChartSignal[] = rawSignals.map((s) => ({
          time: s.time,
          type: s.type,
          source: focusedIndicator.type,
        }));

        // Read the latest chart candles from the store; deps fingerprint
        // already gates this effect on bar-count / boundary changes.
        const liveCandles = useAppStore.getState().candleData;
        const newZones = projectStateOntoChart(indSignals, liveCandles);

        setFocusOverlay({ zones: newZones });
      } catch (err) {
        console.warn('Focus overlay calc failed:', err);
        if (!cancelled) setFocusOverlay({ zones: undefined });
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    focusFingerprint,
    selectedSymbol,
    candleCount,
    firstCandleTime,
    lastCandleTime,
    refreshTick,
  ]);

  // In focus mode, zones carry all the buy/sell context the user needs;
  // signal circles would just visually compete with the coloured backdrop.
  // Outside focus mode the multi-indicator circles still show because there
  // are no zones there to take their place.
  const signals = focusedIndicator ? [] : multiSignals;
  const zones = focusedIndicator ? focusOverlay.zones : undefined;

  // Resolve the current symbol's price precision. Binance pairs come from
  // exchangeInfo's `PRICE_FILTER.tickSize`; for Yahoo (stocks / commodities)
  // we use a magnitude-aware fallback so a $0.50 stock isn't shown as $1.
  const lastClose = candleData[candleData.length - 1]?.close ?? 0;
  const pricePrecision =
    symbolPrecisions[selectedSymbol] ??
    precisionFallback(selectedSymbol, lastClose);

  // During a symbol/timeframe switch the store still holds the previous
  // dataset until the new history fetch resolves. Suppress signal markers
  // and zone shading during that window so we don't briefly paint zones at
  // candle times that belong to a different timeframe entirely.
  const showOverlays = !isLoadingHistory;

  if (isLoadingHistory && candleData.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-foreground-muted">
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full bg-accent animate-pulse" />
          Loading market data…
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <Chart
        data={candleData}
        indicators={indicators}
        indicatorValues={indicatorValues}
        trades={lastBacktest?.trades}
        signals={showOverlays ? signals : []}
        zones={showOverlays ? zones : undefined}
        pricePrecision={pricePrecision}
        datasetKey={`${selectedSymbol}|${timeframe}`}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                  Indicator-timeframe → chart-bar mapping                   */
/* -------------------------------------------------------------------------- */

/**
 * Walks the chart bars and assigns each one the indicator's position state
 * as it stood AT that bar's start time, given the indicator-timeframe
 * signal timeline. So a weekly bar after a 4h BUY but before any subsequent
 * 4h SELL is "long" regardless of intra-week structure.
 */
function projectStateOntoChart(
  indSignals: ChartSignal[],
  chartCandles: Candle[],
): CandlePosition[] {
  if (chartCandles.length === 0) return [];
  if (indSignals.length === 0) {
    return chartCandles.map((c) => ({ time: c.time, state: 'flat' as const }));
  }
  const sorted = [...indSignals].sort((a, b) => a.time - b.time);
  let idx = 0;
  let inLong = false;
  const out: CandlePosition[] = [];
  for (const c of chartCandles) {
    while (idx < sorted.length && sorted[idx].time <= c.time) {
      inLong = sorted[idx].type === 'BUY';
      idx++;
    }
    out.push({ time: c.time, state: inLong ? 'long' : 'flat' });
  }
  return out;
}

