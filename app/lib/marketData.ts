import { fetchKlinesRange } from './binance';
import type { Candle, Timeframe } from './types';

/* -------------------------------------------------------------------------- */
/*                              Asset universe                                */
/* -------------------------------------------------------------------------- */

/**
 * Curated list of US blue-chip and large-cap tickers. Free Yahoo data is
 * delayed ~15 minutes for US equities but is sufficient for charting and
 * indicator analysis. Add/remove tickers freely — they're just suggestions.
 */
export const STOCK_SYMBOLS: string[] = [
  'AAPL',
  'MSFT',
  'GOOGL',
  'AMZN',
  'NVDA',
  'META',
  'TSLA',
  'BRK-B',
  'AVGO',
  'LLY',
  'JPM',
  'V',
  'UNH',
  'JNJ',
  'WMT',
  'XOM',
  'PG',
  'MA',
  'HD',
  'COST',
  'ORCL',
  'ABBV',
  'KO',
  'BAC',
  'PEP',
  'ADBE',
  'CRM',
  'NFLX',
  'AMD',
  'INTC',
  'IBM',
  'DIS',
  'MCD',
  'CVX',
  'NKE',
  'BA',
  'PYPL',
  'UBER',
];

/**
 * Yahoo continuous-front-month futures tickers. The "=F" suffix is Yahoo's
 * convention for these contracts. Prices are usually live (no 15-min delay).
 */
export const COMMODITY_SYMBOLS: string[] = [
  // Metals
  'GC=F',
  'SI=F',
  'PL=F',
  'PA=F',
  'HG=F',
  // Energy
  'CL=F',
  'BZ=F',
  'NG=F',
  'HO=F',
  'RB=F',
  // Grains
  'ZC=F',
  'ZW=F',
  'ZS=F',
  // Softs
  'KC=F',
  'CC=F',
  'CT=F',
  'SB=F',
  'OJ=F',
  // Livestock
  'LE=F',
];

export const COMMODITY_NAMES: Record<string, string> = {
  'GC=F': 'Gold',
  'SI=F': 'Silver',
  'PL=F': 'Platinum',
  'PA=F': 'Palladium',
  'HG=F': 'Copper',
  'CL=F': 'Crude Oil (WTI)',
  'BZ=F': 'Brent Crude',
  'NG=F': 'Natural Gas',
  'HO=F': 'Heating Oil',
  'RB=F': 'RBOB Gasoline',
  'ZC=F': 'Corn',
  'ZW=F': 'Wheat',
  'ZS=F': 'Soybeans',
  'KC=F': 'Coffee',
  'CC=F': 'Cocoa',
  'CT=F': 'Cotton',
  'SB=F': 'Sugar',
  'OJ=F': 'Orange Juice',
  'LE=F': 'Live Cattle',
};

/* -------------------------------------------------------------------------- */
/*                            Asset classification                            */
/* -------------------------------------------------------------------------- */

export type AssetClass = 'crypto' | 'stock' | 'commodity';

// Common Binance quote-asset suffixes. The full universe (set lookup below)
// is preferred when available; this pattern is a cold-start fallback so the
// default symbol (BTCUSDT) doesn't get misrouted to Yahoo before bootstrap
// finishes loading the live universe.
const CRYPTO_QUOTE_PATTERN =
  /^[A-Z0-9]{2,15}(USDT|USDC|BUSD|FDUSD|TUSD|DAI|BTC|ETH|BNB|TRY|EUR|GBP)$/;

function looksLikeCryptoTicker(symbol: string): boolean {
  return CRYPTO_QUOTE_PATTERN.test(symbol);
}

/**
 * Returns the asset class for a given symbol. The live Binance universe is
 * preferred when available (e.g. an arbitrary delisted-but-pattern-matching
 * symbol won't slip through), but the suffix pattern is also accepted so the
 * default symbol routes correctly before bootstrap finishes loading.
 */
export function classifySymbol(
  symbol: string,
  cryptoUniverse: ReadonlySet<string>,
): AssetClass {
  if (cryptoUniverse.has(symbol)) return 'crypto';
  if (symbol.endsWith('=F')) return 'commodity';
  if (looksLikeCryptoTicker(symbol)) return 'crypto';
  return 'stock';
}

/** Friendly display label for a symbol (used in tables and headers). */
export function symbolDisplayName(symbol: string): string {
  if (COMMODITY_NAMES[symbol]) return COMMODITY_NAMES[symbol];
  if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)} / USDT`;
  return symbol;
}

/**
 * Reasonable precision fallback when an explicit per-symbol value isn't
 * available (e.g. Yahoo Finance tickers, or a Binance symbol whose info
 * hasn't loaded yet). For very small prices we use a magnitude-based
 * fallback so dust-priced coins don't display as "0.00".
 */
export function precisionFallback(symbol: string, price: number): number {
  if (symbol.endsWith('=F')) return 4; // commodity futures: penny-fraction ticks
  if (COMMODITY_NAMES[symbol]) return 4;
  if (!symbol.endsWith('USDT')) return 2; // most US equities
  // Crypto fallback by magnitude when tick info isn't loaded yet.
  if (!Number.isFinite(price)) return 4;
  if (price >= 1000) return 2;
  if (price >= 1) return 4;
  if (price >= 0.01) return 5;
  if (price >= 0.0001) return 6;
  return 8;
}

/**
 * Formats a price for display using an explicit precision when known
 * (typically pulled from Binance's `tickSize`) and a magnitude-based
 * fallback when not. Always uses thousands separators above 1k.
 */
export function formatPrice(
  price: number,
  symbol: string,
  precisions: Record<string, number> = {},
): string {
  if (!Number.isFinite(price)) return '—';
  const explicit = precisions[symbol];
  const decimals =
    typeof explicit === 'number' ? explicit : precisionFallback(symbol, price);
  return price.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/* -------------------------------------------------------------------------- */
/*                              Yahoo client                                  */
/* -------------------------------------------------------------------------- */

export interface YahooQuote {
  price: number;
  change: number;
  volume: number;
  currency?: string;
}

/** Fetches latest price + 24h change for a batch of Yahoo tickers. */
export async function fetchYahooQuotes(
  symbols: string[],
): Promise<Record<string, YahooQuote>> {
  if (symbols.length === 0) return {};
  const params = new URLSearchParams({ symbols: symbols.join(',') });
  const res = await fetch(`/api/yahoo/quotes?${params}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Yahoo quotes request failed: ${res.status}`);
  }
  const json = (await res.json()) as { quotes: Record<string, YahooQuote> };
  return json.quotes ?? {};
}

/** Yahoo interval string for our internal timeframe. 4h is approximated by 1h
 * (Yahoo has no 4h granularity). */
function timeframeToYahooInterval(tf: Timeframe): string {
  switch (tf) {
    case '1m':
      return '1m';
    case '5m':
      return '5m';
    case '15m':
      return '15m';
    case '30m':
      return '30m';
    case '1h':
    case '4h':
      return '60m';
    case '1d':
      return '1d';
    case '1w':
      return '1wk';
    default:
      return '1d';
  }
}

function intervalMinutes(interval: string): number {
  switch (interval) {
    case '1m':
      return 1;
    case '5m':
      return 5;
    case '15m':
      return 15;
    case '30m':
      return 30;
    case '60m':
    case '1h':
      return 60;
    case '1d':
      return 1440;
    case '1wk':
      return 10080;
    default:
      return 1440;
  }
}

/** Largest Yahoo range string that fits within the per-interval cap. */
function pickYahooRange(interval: string, requestedDays: number): string {
  const m = intervalMinutes(interval);
  const maxDays =
    m === 1 ? 7 : m <= 5 ? 60 : m <= 90 ? 730 : Number.POSITIVE_INFINITY;
  const days = Math.min(Math.max(1, Math.ceil(requestedDays)), maxDays);
  if (days <= 1) return '1d';
  if (days <= 5) return '5d';
  if (days <= 30) return '1mo';
  if (days <= 90) return '3mo';
  if (days <= 180) return '6mo';
  if (days <= 365) return '1y';
  if (days <= 2 * 365) return '2y';
  if (days <= 5 * 365) return '5y';
  if (days <= 10 * 365) return '10y';
  return 'max';
}

/** Default range for a timeframe when the caller doesn't specify rangeMs. */
function defaultRangeForTimeframe(tf: Timeframe): string {
  switch (tf) {
    case '1m':
      return '5d';
    case '5m':
      return '5d';
    case '15m':
    case '30m':
      return '1mo';
    case '1h':
      return '3mo';
    case '4h':
      return '6mo';
    case '1d':
      return '2y';
    case '1w':
      return '5y';
    default:
      return '2y';
  }
}

export async function fetchYahooCandles(
  symbol: string,
  timeframe: Timeframe,
  options?: { rangeMs?: number },
): Promise<Candle[]> {
  const interval = timeframeToYahooInterval(timeframe);
  const range =
    options?.rangeMs !== undefined
      ? pickYahooRange(interval, options.rangeMs / (24 * 3600 * 1000))
      : defaultRangeForTimeframe(timeframe);
  const params = new URLSearchParams({ symbol, interval, range });
  const res = await fetch(`/api/yahoo/chart?${params}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Yahoo chart request failed: ${res.status}`);
  }
  const json = (await res.json()) as { candles?: Candle[] };
  return Array.isArray(json.candles) ? json.candles : [];
}

/* -------------------------------------------------------------------------- */
/*                       Unified asset-aware kline fetch                      */
/* -------------------------------------------------------------------------- */

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

/**
 * Fetches up to `rangeMs` of historical candles for any symbol, transparently
 * dispatching to Binance (crypto) or Yahoo (stocks/commodities) based on the
 * provided crypto universe.
 */
export async function fetchKlinesForRange(
  symbol: string,
  timeframe: Timeframe,
  rangeMs: number,
  cryptoUniverse: ReadonlySet<string>,
): Promise<Candle[]> {
  const cls = classifySymbol(symbol, cryptoUniverse);
  if (cls === 'crypto') {
    const end = Date.now();
    const start = end - rangeMs;
    const tfMs = TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS['4h'];
    const candlesNeeded = Math.ceil(rangeMs / tfMs);
    const itersNeeded = Math.ceil(candlesNeeded / 1000);
    const maxIterations = Math.min(itersNeeded + 1, 50);
    return fetchKlinesRange(symbol, timeframe, start, end, { maxIterations });
  }
  return fetchYahooCandles(symbol, timeframe, { rangeMs });
}
