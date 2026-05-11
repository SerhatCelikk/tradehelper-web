import { fetchKlinesForRange } from './marketData';
import type { Candle, Timeframe } from './types';

/**
 * Module-scope cache shared between the indicator-performance panel and the
 * chart's focused-indicator overlay so a single fetch of indicator-timeframe
 * candles serves both consumers. Keyed by `${symbol}|${timeframe}`; entries
 * remember the largest range ever requested so a later shorter request can
 * still hit the cache.
 */

interface CacheEntry {
  candles: Candle[];
  fetchedAt: number;
  requestedRangeMs: number;
}

const CACHE_TTL = 60_000;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Candle[]>>();

export async function getCachedKlines(
  symbol: string,
  timeframe: Timeframe,
  rangeMs: number,
  cryptoUniverse: ReadonlySet<string>,
): Promise<Candle[]> {
  const key = `${symbol}|${timeframe}`;
  const cached = cache.get(key);
  if (
    cached &&
    Date.now() - cached.fetchedAt < CACHE_TTL &&
    cached.requestedRangeMs >= rangeMs
  ) {
    return cached.candles;
  }

  const inFlightKey = `${key}|${rangeMs}`;
  const existing = inFlight.get(inFlightKey);
  if (existing) return existing;

  const promise = fetchKlinesForRange(symbol, timeframe, rangeMs, cryptoUniverse)
    .then((candles) => {
      cache.set(key, {
        candles,
        fetchedAt: Date.now(),
        requestedRangeMs: rangeMs,
      });
      return candles;
    })
    .finally(() => {
      inFlight.delete(inFlightKey);
    });
  inFlight.set(inFlightKey, promise);
  return promise;
}

export function invalidateKlinesCache(symbol?: string) {
  if (!symbol) {
    cache.clear();
    return;
  }
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(`${symbol}|`)) cache.delete(k);
  }
}
