'use client';

import { useEffect } from 'react';
import { hydrateStoreFromStorage, useAppStore, type SymbolStat } from '../store/store';
import { database } from '../lib/database';
import { registerServiceWorker } from '../lib/notifications';
import { fetchAllUsdtTickers, fetchUsdtSymbolsInfo } from '../lib/binance';
import {
  COMMODITY_SYMBOLS,
  STOCK_SYMBOLS,
  fetchYahooQuotes,
} from '../lib/marketData';

const CRYPTO_REFRESH_MS = 30_000;
const YAHOO_REFRESH_MS = 60_000;

export default function AppBootstrap() {
  const setDatabaseReady = useAppStore((s) => s.setDatabaseReady);
  const setAlerts = useAppStore((s) => s.setAlerts);
  const setStrategies = useAppStore((s) => s.setStrategies);
  const setNotificationPermission = useAppStore(
    (s) => s.setNotificationPermission,
  );
  const setAllSymbols = useAppStore((s) => s.setAllSymbols);
  const setStockSymbols = useAppStore((s) => s.setStockSymbols);
  const setCommoditySymbols = useAppStore((s) => s.setCommoditySymbols);
  const setSymbolStats = useAppStore((s) => s.setSymbolStats);
  const mergeSymbolStats = useAppStore((s) => s.mergeSymbolStats);
  const setSymbolPrecisions = useAppStore((s) => s.setSymbolPrecisions);
  const setSymbolsLoading = useAppStore((s) => s.setSymbolsLoading);
  const setSymbolsError = useAppStore((s) => s.setSymbolsError);

  useEffect(() => {
    hydrateStoreFromStorage();

    let cancelled = false;

    (async () => {
      try {
        await database.init();
        if (cancelled) return;
        const alerts = await database.getAlerts();
        const strategies = await database.getStrategies();
        setAlerts(alerts);
        setStrategies(strategies);
        setDatabaseReady(true);
      } catch (err) {
        console.error('Database init failed:', err);
      }
    })();

    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotificationPermission(
        (Notification.permission as NotificationPermission | 'default') ||
          'default',
      );
    }

    registerServiceWorker().catch((err) => {
      console.warn('SW register failed:', err);
    });

    // ---- Seed Yahoo universes immediately so the panel can render rows
    // before any network round-trip resolves.
    setStockSymbols(STOCK_SYMBOLS);
    setCommoditySymbols(COMMODITY_SYMBOLS);

    // ---- Symbol universe: load once, then refresh ticker stats periodically.
    setSymbolsLoading(true);
    setSymbolsError(null);

    let cryptoTimer: ReturnType<typeof setInterval> | null = null;
    let yahooTimer: ReturnType<typeof setInterval> | null = null;

    (async () => {
      try {
        const [info, tickers] = await Promise.all([
          fetchUsdtSymbolsInfo(),
          fetchAllUsdtTickers(),
        ]);
        if (cancelled) return;

        const validSet = new Set(info.map((s) => s.symbol));
        const stats: Record<string, SymbolStat> = {};
        for (const t of tickers) {
          if (!validSet.has(t.symbol)) continue;
          stats[t.symbol] = {
            price: t.price,
            change: t.priceChangePercent,
            volume: t.volume24h,
          };
        }

        // Per-symbol price precision from each pair's PRICE_FILTER tickSize.
        const precisions: Record<string, number> = {};
        for (const s of info) precisions[s.symbol] = s.pricePrecision;

        // Sort by 24h quote volume so popular pairs surface first.
        const sortedSymbols = Array.from(validSet).sort((a, b) => {
          const va = stats[a]?.volume ?? 0;
          const vb = stats[b]?.volume ?? 0;
          return vb - va;
        });

        setAllSymbols(sortedSymbols);
        setSymbolStats(stats);
        setSymbolPrecisions(precisions);
        setSymbolsLoading(false);
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load Binance symbols';
        console.error('[bootstrap] symbol load failed:', err);
        setSymbolsError(message);
        setSymbolsLoading(false);
      }

      // Periodic crypto ticker refresh.
      cryptoTimer = setInterval(async () => {
        try {
          const tickers = await fetchAllUsdtTickers();
          if (cancelled) return;
          const validSet = new Set(useAppStore.getState().allSymbols);
          const stats: Record<string, SymbolStat> = {};
          for (const t of tickers) {
            if (!validSet.has(t.symbol)) continue;
            stats[t.symbol] = {
              price: t.price,
              change: t.priceChangePercent,
              volume: t.volume24h,
            };
          }
          mergeSymbolStats(stats);
        } catch (err) {
          console.warn('[bootstrap] crypto refresh failed:', err);
        }
      }, CRYPTO_REFRESH_MS);
    })();

    // ---- Yahoo quotes (stocks + commodities). Independent of the Binance
    // promise above — failures here don't block crypto and vice versa.
    const refreshYahoo = async () => {
      const all = [...STOCK_SYMBOLS, ...COMMODITY_SYMBOLS];
      try {
        const quotes = await fetchYahooQuotes(all);
        if (cancelled) return;
        const stats: Record<string, SymbolStat> = {};
        for (const [sym, q] of Object.entries(quotes)) {
          stats[sym] = {
            price: q.price,
            change: q.change,
            volume: q.volume,
          };
        }
        mergeSymbolStats(stats);
      } catch (err) {
        console.warn('[bootstrap] yahoo refresh failed:', err);
      }
    };

    refreshYahoo();
    yahooTimer = setInterval(refreshYahoo, YAHOO_REFRESH_MS);

    return () => {
      cancelled = true;
      if (cryptoTimer) clearInterval(cryptoTimer);
      if (yahooTimer) clearInterval(yahooTimer);
    };
  }, [
    setAlerts,
    setStrategies,
    setDatabaseReady,
    setNotificationPermission,
    setAllSymbols,
    setStockSymbols,
    setCommoditySymbols,
    setSymbolStats,
    mergeSymbolStats,
    setSymbolPrecisions,
    setSymbolsLoading,
    setSymbolsError,
  ]);

  return null;
}
