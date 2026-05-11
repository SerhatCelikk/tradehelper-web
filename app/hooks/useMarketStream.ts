'use client';

import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/store';
import {
  fetchKlines,
  fetchTickerStats,
  getBinanceWS,
  type KlineUpdate,
  type TickerUpdate,
} from '../lib/binance';
import { classifySymbol, fetchYahooCandles } from '../lib/marketData';
import type { Candle, Timeframe } from '../lib/types';

const YAHOO_POLL_MS = 30_000;

/**
 * Wires the selected symbol + timeframe to the right data source:
 *   - crypto (USDT pairs in the Binance universe) → live WebSocket stream
 *   - stocks / commodities (Yahoo Finance) → REST polling
 *
 * The component-facing surface is identical: candle data flows into the
 * global store and the chart picks it up. The Binance WS is disconnected
 * automatically when a non-crypto symbol is selected.
 */
export function useMarketStream() {
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const timeframe = useAppStore((s) => s.timeframe);
  // We need the crypto universe to classify the symbol; falling back to a
  // simple "ends with USDT" heuristic here would misclassify the first paint,
  // before bootstrap finishes loading the universe.
  const allSymbols = useAppStore((s) => s.allSymbols);

  const setCandleData = useAppStore((s) => s.setCandleData);
  const appendCandle = useAppStore((s) => s.appendCandle);
  const setTicker = useAppStore((s) => s.setTicker);
  const setStreamConnected = useAppStore((s) => s.setStreamConnected);
  const setStreamError = useAppStore((s) => s.setStreamError);
  const setLoadingHistory = useAppStore((s) => s.setLoadingHistory);

  const activeKey = useRef<string | null>(null);

  useEffect(() => {
    const cryptoUniverse = new Set(allSymbols);
    const cls = classifySymbol(selectedSymbol, cryptoUniverse);
    const key = `${cls}|${selectedSymbol}|${timeframe}`;
    activeKey.current = key;

    let cancelled = false;

    setLoadingHistory(true);
    setStreamError(null);

    if (cls === 'crypto') {
      return wireCryptoStream({
        symbol: selectedSymbol,
        timeframe,
        key,
        getActive: () => activeKey.current,
        isCancelled: () => cancelled,
        cancel: () => {
          cancelled = true;
        },
        setCandleData,
        appendCandle,
        setTicker,
        setStreamConnected,
        setStreamError,
        setLoadingHistory,
      });
    }

    // ---- Yahoo (stocks / commodities) ----
    // Binance has no relevance here — make sure its socket is closed so we
    // don't keep an idle WS hanging around.
    getBinanceWS().disconnect();
    // Optimistically assume the polling channel is healthy; it'll flip to
    // false again on the first request error so the UI stays accurate. Keeping
    // this at `false` would surface a permanent "Reconnecting…" toast even
    // though we're not using a WebSocket at all.
    setStreamConnected(true);

    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const loadOnce = async () => {
      try {
        const candles = await fetchYahooCandles(selectedSymbol, timeframe);
        if (cancelled || activeKey.current !== key) return;
        setCandleData(candles);
        const last = candles[candles.length - 1];
        if (last) {
          const first = candles[0];
          const change =
            first && first.close > 0
              ? ((last.close - first.close) / first.close) * 100
              : 0;
          setTicker({
            symbol: selectedSymbol,
            price: last.close,
            priceChangePercent: change,
            high24h: Math.max(...candles.map((c) => c.high)),
            low24h: Math.min(...candles.map((c) => c.low)),
            volume24h: candles.reduce((s, c) => s + c.volume, 0),
          });
        }
        setStreamConnected(true);
      } catch (err) {
        if (cancelled || activeKey.current !== key) return;
        console.error('Yahoo history fetch failed:', err);
        setStreamError('Failed to load market data. Retrying…');
        setStreamConnected(false);
      } finally {
        if (!cancelled && activeKey.current === key) setLoadingHistory(false);
      }
    };

    loadOnce();

    pollTimer = setInterval(async () => {
      try {
        const candles = await fetchYahooCandles(selectedSymbol, timeframe);
        if (cancelled || activeKey.current !== key) return;
        // Apply only the tail bar so we preserve the user's pan/zoom — the
        // chart's "datasetKey" approach already preserves zoom across full
        // setData calls, but updating bar-by-bar is lighter and avoids any
        // visual jitter when long histories rewrite.
        const tail = candles[candles.length - 1];
        if (tail) appendCandle(tail as Candle);
      } catch (err) {
        console.warn('Yahoo poll failed:', err);
      }
    }, YAHOO_POLL_MS);

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [
    selectedSymbol,
    timeframe,
    allSymbols,
    setCandleData,
    appendCandle,
    setTicker,
    setStreamConnected,
    setStreamError,
    setLoadingHistory,
  ]);
}

/* -------------------------------------------------------------------------- */
/*                              Binance branch                                */
/* -------------------------------------------------------------------------- */

interface CryptoWireParams {
  symbol: string;
  timeframe: Timeframe;
  key: string;
  getActive: () => string | null;
  isCancelled: () => boolean;
  cancel: () => void;
  setCandleData: (c: Candle[]) => void;
  appendCandle: (c: Candle) => void;
  setTicker: (t: ReturnType<typeof useAppStore.getState>['ticker']) => void;
  setStreamConnected: (b: boolean) => void;
  setStreamError: (e: string | null) => void;
  setLoadingHistory: (b: boolean) => void;
}

function wireCryptoStream(p: CryptoWireParams): () => void {
  const ws = getBinanceWS();

  (async () => {
    try {
      const [history, tickers] = await Promise.all([
        fetchKlines(p.symbol, p.timeframe, { limit: 500 }),
        fetchTickerStats([p.symbol]),
      ]);
      if (p.isCancelled() || p.getActive() !== p.key) return;
      p.setCandleData(history);
      if (tickers[0]) p.setTicker(tickers[0]);
    } catch (err) {
      if (p.isCancelled()) return;
      console.error('Binance history fetch failed:', err);
      p.setStreamError('Failed to load history. Retrying…');
    } finally {
      if (!p.isCancelled() && p.getActive() === p.key) p.setLoadingHistory(false);
    }
  })();

  ws.setSubscriptions([{ symbol: p.symbol, interval: p.timeframe }]);
  ws.connect();

  const offCandle = ws.onCandle((u: KlineUpdate) => {
    if (
      u.symbol.toUpperCase() !== p.symbol.toUpperCase() ||
      u.interval !== p.timeframe
    ) {
      return;
    }
    p.appendCandle(u.candle);
  });

  const offTicker = ws.onTicker((u: TickerUpdate) => {
    if (u.symbol.toUpperCase() !== p.symbol.toUpperCase()) return;
    p.setTicker({
      symbol: u.symbol,
      price: u.price,
      priceChangePercent: u.priceChangePercent,
      high24h: 0,
      low24h: 0,
      volume24h: 0,
    });
  });

  const offConn = ws.onConnection((connected) => {
    p.setStreamConnected(connected);
    if (connected) p.setStreamError(null);
  });

  return () => {
    p.cancel();
    offCandle();
    offTicker();
    offConn();
  };
}
