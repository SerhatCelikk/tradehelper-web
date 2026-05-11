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

/**
 * Drives the Binance combined stream subscription based on the selected
 * symbol/timeframe in the global store and writes updates back into it.
 */
export function useBinanceStream() {
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const timeframe = useAppStore((s) => s.timeframe);

  const setCandleData = useAppStore((s) => s.setCandleData);
  const appendCandle = useAppStore((s) => s.appendCandle);
  const setTicker = useAppStore((s) => s.setTicker);
  const setStreamConnected = useAppStore((s) => s.setStreamConnected);
  const setStreamError = useAppStore((s) => s.setStreamError);
  const setLoadingHistory = useAppStore((s) => s.setLoadingHistory);

  const activeKey = useRef<string | null>(null);

  useEffect(() => {
    const ws = getBinanceWS();
    const key = `${selectedSymbol}|${timeframe}`;
    activeKey.current = key;

    let cancelled = false;

    setLoadingHistory(true);
    setStreamError(null);

    (async () => {
      try {
        const [history, tickers] = await Promise.all([
          fetchKlines(selectedSymbol, timeframe, { limit: 500 }),
          fetchTickerStats([selectedSymbol]),
        ]);
        if (cancelled || activeKey.current !== key) return;
        setCandleData(history);
        if (tickers[0]) setTicker(tickers[0]);
      } catch (err) {
        if (cancelled) return;
        console.error('History fetch failed:', err);
        setStreamError('Failed to load history. Retrying…');
      } finally {
        if (!cancelled && activeKey.current === key) setLoadingHistory(false);
      }
    })();

    ws.setSubscriptions([{ symbol: selectedSymbol, interval: timeframe }]);
    ws.connect();

    const offCandle = ws.onCandle((u: KlineUpdate) => {
      if (
        u.symbol.toUpperCase() !== selectedSymbol.toUpperCase() ||
        u.interval !== timeframe
      ) {
        return;
      }
      appendCandle(u.candle);
    });

    const offTicker = ws.onTicker((u: TickerUpdate) => {
      if (u.symbol.toUpperCase() !== selectedSymbol.toUpperCase()) return;
      setTicker({
        symbol: u.symbol,
        price: u.price,
        priceChangePercent: u.priceChangePercent,
        high24h: 0,
        low24h: 0,
        volume24h: 0,
      });
    });

    const offConn = ws.onConnection((connected) => {
      setStreamConnected(connected);
      if (connected) setStreamError(null);
    });

    return () => {
      cancelled = true;
      offCandle();
      offTicker();
      offConn();
    };
  }, [
    selectedSymbol,
    timeframe,
    setCandleData,
    appendCandle,
    setTicker,
    setStreamConnected,
    setStreamError,
    setLoadingHistory,
  ]);
}
