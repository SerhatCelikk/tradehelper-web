'use client';

import {
  createChart,
  CrosshairMode,
  LineStyle,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type {
  Candle,
  CandlePosition,
  ChartSignal,
  IndicatorConfig,
  IndicatorValues,
  Trade,
} from '../lib/types';

interface Props {
  data: Candle[];
  indicators: IndicatorConfig[];
  indicatorValues: IndicatorValues;
  trades?: Trade[];
  /**
   * Live indicator-driven buy/sell points. Rendered as small green/red
   * circles (buy below the bar, sell above) so they sit within a single
   * candle's width and don't compete visually with the larger backtest
   * arrow markers.
   */
  signals?: ChartSignal[];
  /**
   * Per-candle position state for the focused indicator. Rendered as soft
   * green ("long") and red ("flat") translucent bands behind the candles.
   * Pass `undefined`/empty to hide zone shading.
   */
  zones?: CandlePosition[];
  /**
   * Decimal places to display on the price axis / crosshair / last-value
   * label. Sourced from Binance's `tickSize` for the current symbol so
   * dust-priced coins read as "0.00001234" instead of getting clipped to
   * "0.00". Pair with `tickSize` so the axis snaps to actual increments.
   */
  pricePrecision?: number;
  pricePrecisionTickSize?: number;
  /**
   * Identifier for the current dataset (typically `${symbol}|${timeframe}`).
   * Used to decide when to auto-fit the visible range. While this key stays
   * the same, incoming candles are treated as appends and the user's pan/zoom
   * is preserved. When it changes, the view auto-fits the new dataset.
   */
  datasetKey?: string;
}

const CHART_BG = '#1E1E1E';
const TEXT = '#D9D9D9';
const GRID = '#2B2B43';
const UP = '#26A69A';
const DOWN = '#EF5350';

export default function Chart({
  data,
  indicators,
  indicatorValues,
  trades,
  signals,
  zones,
  pricePrecision,
  pricePrecisionTickSize,
  datasetKey,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const longZoneRef = useRef<ISeriesApi<'Area'> | null>(null);
  const flatZoneRef = useRef<ISeriesApi<'Area'> | null>(null);
  const overlayRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const subPaneRefs = useRef<Map<string, ISeriesApi<'Line' | 'Histogram'>>>(
    new Map(),
  );
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const lastDatasetKeyRef = useRef<string | null>(null);

  // Init chart once
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      autoSize: true,
      layout: {
        background: { color: CHART_BG },
        textColor: TEXT,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: GRID, style: LineStyle.Dotted },
        horzLines: { color: GRID, style: LineStyle.Dotted },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: GRID },
      timeScale: {
        borderColor: GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
    });

    // Zone backdrop area series. Added BEFORE the candle series so they
    // render behind the bars rather than on top of them. Both live on an
    // invisible price scale; feeding both 0 and 1 values lets the
    // auto-scale fit to [0, 1], so a value=1 area fills the full chart
    // height and a value=0 area collapses to nothing — giving us crisp,
    // single-candle-wide on/off bands. `LastPriceAnimation.Disabled` plus
    // the no-line/no-crosshair flags keep the overlay invisible-except-fill.
    const longZoneSeries = chart.addAreaSeries({
      priceScaleId: 'zones-overlay',
      topColor: 'rgba(38, 166, 154, 0.24)',
      bottomColor: 'rgba(38, 166, 154, 0.08)',
      lineColor: 'rgba(0,0,0,0)',
      lineWidth: 1,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      baseLineVisible: false,
    });
    const flatZoneSeries = chart.addAreaSeries({
      priceScaleId: 'zones-overlay',
      topColor: 'rgba(239, 83, 80, 0.24)',
      bottomColor: 'rgba(239, 83, 80, 0.08)',
      lineColor: 'rgba(0,0,0,0)',
      lineWidth: 1,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      baseLineVisible: false,
    });
    chart.priceScale('zones-overlay').applyOptions({
      visible: false,
      scaleMargins: { top: 0, bottom: 0 },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceScaleId: 'right',
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: '#26A69A88',
    });

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
      visible: false,
    });

    chart.priceScale('right').applyOptions({
      scaleMargins: { top: 0.05, bottom: 0.2 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    longZoneRef.current = longZoneSeries;
    flatZoneRef.current = flatZoneSeries;

    const ro = new ResizeObserver(() => {
      if (chartRef.current && container) {
        chartRef.current.applyOptions({
          width: container.clientWidth,
          height: container.clientHeight,
        });
      }
    });
    ro.observe(container);
    resizeObserverRef.current = ro;

    const overlayMap = overlayRefs.current;
    const subPaneMap = subPaneRefs.current;

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      longZoneRef.current = null;
      flatZoneRef.current = null;
      overlayMap.clear();
      subPaneMap.clear();
    };
  }, []);

  // Push the per-symbol price precision through to the candle series so the
  // right-axis labels, crosshair tooltip, and last-price line all render
  // with the right number of decimals. Without this, lightweight-charts
  // defaults to 2 decimals and dust-priced coins clip to "0.00".
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    if (pricePrecision === undefined) return;
    const minMove =
      pricePrecisionTickSize && pricePrecisionTickSize > 0
        ? pricePrecisionTickSize
        : Math.pow(10, -pricePrecision);
    series.applyOptions({
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove,
      },
    });
  }, [pricePrecision, pricePrecisionTickSize]);

  // Position-zone shading. Each candle emits an explicit numeric value
  // (1 = band visible, 0 = band invisible) on both series. Using 0 instead
  // of whitespace anchors the price scale's auto-fit to the [0, 1] range,
  // which is what makes value=1 actually fill the chart height; with
  // whitespace-only off points the scale collapses to [1, 1] and the bands
  // were rendered as a thin nondescript strip — that's the "gray area" you
  // were seeing. Step-line interpolation gives sharp vertical boundaries
  // at the signal candle rather than diagonal ramps.
  useEffect(() => {
    const longSeries = longZoneRef.current;
    const flatSeries = flatZoneRef.current;
    if (!longSeries || !flatSeries) return;

    if (!zones || zones.length === 0) {
      longSeries.setData([]);
      flatSeries.setData([]);
      return;
    }

    const longData = zones.map((z) => ({
      time: z.time as UTCTimestamp,
      value: z.state === 'long' ? 1 : 0,
    }));
    const flatData = zones.map((z) => ({
      time: z.time as UTCTimestamp,
      value: z.state === 'flat' ? 1 : 0,
    }));
    longSeries.setData(longData);
    flatSeries.setData(flatData);
  }, [zones]);

  // Update OHLCV data. We always replace the underlying series data (cheap
  // diff inside lightweight-charts) so indicators stay aligned, but we only
  // auto-fit the visible range when the *dataset identity* changes — i.e.
  // when the symbol or timeframe switches. Real-time appends keep whatever
  // pan/zoom the user has set.
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    const series = candleSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!data || data.length === 0) {
      series.setData([]);
      volume.setData([]);
      lastDatasetKeyRef.current = null;
      return;
    }
    series.setData(
      data.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    volume.setData(
      data.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? '#26A69A77' : '#EF535077',
      })),
    );

    const key = datasetKey ?? 'default';
    if (lastDatasetKeyRef.current !== key) {
      chartRef.current?.timeScale().fitContent();
      lastDatasetKeyRef.current = key;
    }
  }, [data, datasetKey]);

  // Manage overlays / sub-panes for indicators
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !data || data.length === 0) return;

    const enabled = indicators.filter((i) => i.enabled);
    const wantedKeys = new Set<string>();

    // ---------- OVERLAY series (BB / SMA / EMA) ----------
    for (const ind of enabled) {
      if (ind.type === 'BBANDS' && indicatorValues.bbands) {
        const { upper, middle, lower } = indicatorValues.bbands;
        addOrUpdateLine(
          chart,
          overlayRefs.current,
          `bb-upper-${ind.id}`,
          '#9C27B0',
          mapToLineData(data, upper),
        );
        addOrUpdateLine(
          chart,
          overlayRefs.current,
          `bb-middle-${ind.id}`,
          '#FF9800',
          mapToLineData(data, middle),
          { lineStyle: LineStyle.Dashed },
        );
        addOrUpdateLine(
          chart,
          overlayRefs.current,
          `bb-lower-${ind.id}`,
          '#9C27B0',
          mapToLineData(data, lower),
        );
        wantedKeys.add(`bb-upper-${ind.id}`);
        wantedKeys.add(`bb-middle-${ind.id}`);
        wantedKeys.add(`bb-lower-${ind.id}`);
      }
      if (ind.type === 'SMA') {
        const period = ind.params.period ?? 20;
        const series = indicatorValues.sma.find((s) => s.period === period);
        if (series) {
          addOrUpdateLine(
            chart,
            overlayRefs.current,
            `sma-${ind.id}`,
            ind.color,
            mapToLineData(data, series.values),
          );
          wantedKeys.add(`sma-${ind.id}`);
        }
      }
      if (ind.type === 'EMA') {
        const period = ind.params.period ?? 20;
        const series = indicatorValues.ema.find((s) => s.period === period);
        if (series) {
          addOrUpdateLine(
            chart,
            overlayRefs.current,
            `ema-${ind.id}`,
            ind.color,
            mapToLineData(data, series.values),
          );
          wantedKeys.add(`ema-${ind.id}`);
        }
      }
    }

    // Remove overlay series that are no longer wanted
    for (const [k, s] of overlayRefs.current.entries()) {
      if (!wantedKeys.has(k)) {
        chart.removeSeries(s);
        overlayRefs.current.delete(k);
      }
    }

    // ---------- SUB-PANE series (RSI / MACD) ----------
    const wantedSubKeys = new Set<string>();

    if (
      enabled.some((i) => i.type === 'RSI') &&
      indicatorValues.rsi &&
      indicatorValues.rsi.length > 0
    ) {
      const id = enabled.find((i) => i.type === 'RSI')!.id;
      addOrUpdateLine(
        chart,
        subPaneRefs.current as Map<string, ISeriesApi<'Line'>>,
        `rsi-${id}`,
        '#2962FF',
        mapToLineData(data, indicatorValues.rsi),
        { priceScaleId: 'rsi-pane', lineWidth: 2 },
      );
      chart.priceScale('rsi-pane').applyOptions({
        scaleMargins: { top: 0.7, bottom: 0 },
        visible: true,
        borderColor: GRID,
      });
      wantedSubKeys.add(`rsi-${id}`);
    }

    if (
      enabled.some((i) => i.type === 'MACD') &&
      indicatorValues.macd
    ) {
      const id = enabled.find((i) => i.type === 'MACD')!.id;
      const { MACD, signal, histogram } = indicatorValues.macd;
      addOrUpdateLine(
        chart,
        subPaneRefs.current as Map<string, ISeriesApi<'Line'>>,
        `macd-line-${id}`,
        '#26A69A',
        mapToLineData(data, MACD),
        { priceScaleId: 'macd-pane', lineWidth: 2 },
      );
      addOrUpdateLine(
        chart,
        subPaneRefs.current as Map<string, ISeriesApi<'Line'>>,
        `macd-signal-${id}`,
        '#EF5350',
        mapToLineData(data, signal),
        { priceScaleId: 'macd-pane', lineWidth: 2 },
      );

      // Histogram series
      const histKey = `macd-hist-${id}`;
      let hist = subPaneRefs.current.get(histKey) as
        | ISeriesApi<'Histogram'>
        | undefined;
      if (!hist) {
        hist = chart.addHistogramSeries({
          priceScaleId: 'macd-pane',
          color: '#26A69A',
        });
        subPaneRefs.current.set(histKey, hist);
      }
      hist.setData(
        mapToLineData(data, histogram).map((d) => ({
          time: d.time,
          value: d.value,
          color: d.value >= 0 ? '#26A69A77' : '#EF535077',
        })),
      );
      chart.priceScale('macd-pane').applyOptions({
        scaleMargins: { top: 0.7, bottom: 0 },
        visible: true,
        borderColor: GRID,
      });
      wantedSubKeys.add(`macd-line-${id}`);
      wantedSubKeys.add(`macd-signal-${id}`);
      wantedSubKeys.add(histKey);
    }

    for (const [k, s] of subPaneRefs.current.entries()) {
      if (!wantedSubKeys.has(k)) {
        chart.removeSeries(s);
        subPaneRefs.current.delete(k);
      }
    }
  }, [indicators, indicatorValues, data]);

  // Trade + signal markers. lightweight-charts accepts only one marker array
  // per series, so we merge both sources here. Markers must be sorted by time.
  //
  //   • Backtest trades (from `trades`) → big arrows + price/PnL text label.
  //   • Indicator signals (from `signals`) → small green/red circles, no text,
  //     so the visual stays clean even when there are many per chart.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    const tradeMarkers: SeriesMarker<Time>[] = (trades ?? []).map((t) => ({
      time: t.time as UTCTimestamp,
      position: t.type === 'BUY' ? 'belowBar' : 'aboveBar',
      color: t.type === 'BUY' ? UP : DOWN,
      shape: t.type === 'BUY' ? 'arrowUp' : 'arrowDown',
      text:
        t.type === 'BUY'
          ? `B @${formatNum(t.price)}`
          : `S @${formatNum(t.price)}${
              t.pnlPercent !== undefined
                ? ` (${t.pnlPercent >= 0 ? '+' : ''}${t.pnlPercent.toFixed(2)}%)`
                : ''
            }`,
    }));

    const signalMarkers: SeriesMarker<Time>[] = (signals ?? []).map((s) => ({
      time: s.time as UTCTimestamp,
      position: s.type === 'BUY' ? 'belowBar' : 'aboveBar',
      color: s.type === 'BUY' ? UP : DOWN,
      shape: 'circle',
      // `size` defaults to 1; lightweight-charts shrinks circles to fit within
      // a single bar's width without extra config.
    }));

    if (tradeMarkers.length === 0 && signalMarkers.length === 0) {
      series.setMarkers([]);
      return;
    }

    const merged = [...tradeMarkers, ...signalMarkers].sort(
      (a, b) => Number(a.time) - Number(b.time),
    );
    series.setMarkers(merged);
  }, [trades, signals]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function addOrUpdateLine(
  chart: IChartApi,
  registry: Map<string, ISeriesApi<'Line'>>,
  key: string,
  color: string,
  data: { time: UTCTimestamp; value: number }[],
  opts?: { priceScaleId?: string; lineWidth?: 1 | 2 | 3 | 4; lineStyle?: LineStyle },
) {
  let s = registry.get(key);
  if (!s) {
    s = chart.addLineSeries({
      color,
      lineWidth: opts?.lineWidth ?? 2,
      lineStyle: opts?.lineStyle ?? LineStyle.Solid,
      priceScaleId: opts?.priceScaleId,
      lastValueVisible: true,
      priceLineVisible: false,
    });
    registry.set(key, s);
  } else {
    s.applyOptions({
      color,
      lineWidth: opts?.lineWidth ?? 2,
      lineStyle: opts?.lineStyle ?? LineStyle.Solid,
    });
  }
  s.setData(data);
}

function mapToLineData(
  candles: Candle[],
  values: number[],
): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = [];
  // Indicator output is left-aligned to the candle range. The library's
  // `technicalindicators` returns arrays starting at the first valid candle,
  // so right-pad alignment with the END of the candle range.
  const offset = candles.length - values.length;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    out.push({
      time: candles[offset + i].time as UTCTimestamp,
      value: v,
    });
  }
  return out;
}

function formatNum(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
