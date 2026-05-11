import type { Candle, Ticker, Timeframe } from './types';

/* -------------------------------------------------------------------------- */
/*                          Endpoint pools (with fallback)                    */
/* -------------------------------------------------------------------------- */

/**
 * Binance exposes the same data through several mirrors. Some networks
 * (ISP-level filters, ad-blockers, certain country firewalls) block
 * `api.binance.com` but allow the public-data mirror at
 * `data-api.binance.vision`. We try them in order and remember the first
 * one that works.
 */
const REST_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
  'https://api-gcp.binance.com',
] as const;

const WS_ENDPOINTS = [
  'wss://data-stream.binance.vision/stream',
  'wss://stream.binance.com:9443/stream',
  'wss://stream.binance.com:443/stream',
] as const;

const STORAGE_REST_KEY = 'th_rest_endpoint';
const STORAGE_WS_KEY = 'th_ws_endpoint';

function loadStickyEndpoint(key: string, allowed: readonly string[]): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(key);
    return v && allowed.includes(v) ? v : null;
  } catch {
    return null;
  }
}

function saveStickyEndpoint(key: string, value: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

let workingRestEndpoint: string | null = loadStickyEndpoint(
  STORAGE_REST_KEY,
  REST_ENDPOINTS,
);

function restCandidates(): string[] {
  if (workingRestEndpoint) {
    return [
      workingRestEndpoint,
      ...REST_ENDPOINTS.filter((e) => e !== workingRestEndpoint),
    ];
  }
  return [...REST_ENDPOINTS];
}

/* -------------------------------------------------------------------------- */
/*                              Rate limiter + fetch                          */
/* -------------------------------------------------------------------------- */

class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly limit = 1100, // safe under Binance 1200/min weight cap
    private readonly windowMs = 60_000,
  ) {}

  async acquire() {
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now);
        return;
      }
      const wait = this.windowMs - (now - this.timestamps[0]) + 5;
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}

const restLimiter = new RateLimiter();

export class BinanceNetworkError extends Error {
  endpointsTried: string[];
  constructor(endpoints: string[], cause?: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Could not reach Binance from this network (tried ${endpoints.length} endpoints). ` +
        `Last error: ${reason}. ` +
        `Check your internet connection, ad-blocker, VPN or DNS — ` +
        `if api.binance.com is blocked in your region, try enabling a VPN.`,
    );
    this.name = 'BinanceNetworkError';
    this.endpointsTried = endpoints;
  }
}

const FETCH_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeFetch(path: string, init?: RequestInit): Promise<Response> {
  await restLimiter.acquire();

  const candidates = restCandidates();
  let lastError: unknown = null;
  const tried: string[] = [];

  for (const base of candidates) {
    const url = `${base}${path}`;
    tried.push(base);
    try {
      const res = await fetchWithTimeout(url, init);

      if (res.status === 429 || res.status === 418) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '5');
        await new Promise((r) =>
          setTimeout(r, Math.min(60_000, retryAfter * 1000)),
        );
        return safeFetch(path, init);
      }

      // Endpoint is reachable (even if HTTP 4xx/5xx). Pin it.
      if (workingRestEndpoint !== base) {
        workingRestEndpoint = base;
        saveStickyEndpoint(STORAGE_REST_KEY, base);
      }
      return res;
    } catch (err) {
      lastError = err;
      // Network/CORS/timeout error → try next candidate.
      if (workingRestEndpoint === base) {
        workingRestEndpoint = null;
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.removeItem(STORAGE_REST_KEY);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  throw new BinanceNetworkError(tried, lastError);
}

/* -------------------------------------------------------------------------- */
/*                                  REST API                                  */
/* -------------------------------------------------------------------------- */

const VALID_INTERVALS = new Set([
  '1s',
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
]);

export async function fetchKlines(
  symbol: string,
  interval: Timeframe,
  options: {
    startTime?: number;
    endTime?: number;
    limit?: number;
  } = {},
): Promise<Candle[]> {
  if (!symbol || typeof symbol !== 'string') {
    throw new Error(`fetchKlines: invalid symbol ${String(symbol)}`);
  }
  if (!interval || !VALID_INTERVALS.has(interval)) {
    throw new Error(
      `fetchKlines: invalid interval ${String(interval)} for ${symbol}`,
    );
  }
  const params = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    interval,
    limit: String(options.limit ?? 500),
  });
  if (options.startTime) params.set('startTime', String(options.startTime));
  if (options.endTime) params.set('endTime', String(options.endTime));

  const res = await safeFetch(`/api/v3/klines?${params}`);
  if (!res.ok) {
    throw new Error(
      `Binance klines request failed: ${res.status} ${res.statusText}`,
    );
  }
  const raw: Array<Array<string | number>> = await res.json();
  return raw.map(parseKlineRow);
}

function parseKlineRow(row: Array<string | number>): Candle {
  return {
    time: Math.floor(Number(row[0]) / 1000),
    open: parseFloat(row[1] as string),
    high: parseFloat(row[2] as string),
    low: parseFloat(row[3] as string),
    close: parseFloat(row[4] as string),
    volume: parseFloat(row[5] as string),
  };
}

export async function fetchKlinesRange(
  symbol: string,
  interval: Timeframe,
  startTime: number,
  endTime: number,
  options: { maxIterations?: number } = {},
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startTime;
  const maxIterations = options.maxIterations ?? 8;
  let iter = 0;

  while (cursor < endTime && iter < maxIterations) {
    iter++;
    const batch = await fetchKlines(symbol, interval, {
      startTime: cursor,
      endTime,
      limit: 1000,
    });
    if (batch.length === 0) break;
    for (const c of batch) {
      if (out.length === 0 || c.time > out[out.length - 1].time) {
        out.push(c);
      }
    }
    const lastMs = batch[batch.length - 1].time * 1000;
    if (lastMs <= cursor) break;
    cursor = lastMs + 1;
    if (batch.length < 1000) break;
  }
  return out;
}

export async function fetchTickerStats(symbols: string[]): Promise<Ticker[]> {
  if (symbols.length === 0) return [];
  const param = encodeURIComponent(
    JSON.stringify(symbols.map((s) => s.toUpperCase())),
  );
  const res = await safeFetch(`/api/v3/ticker/24hr?symbols=${param}`);
  if (!res.ok) {
    throw new Error(`Binance ticker request failed: ${res.status}`);
  }
  const arr: Array<Record<string, string>> = await res.json();
  return arr.map((t) => ({
    symbol: t.symbol,
    price: parseFloat(t.lastPrice),
    priceChangePercent: parseFloat(t.priceChangePercent),
    high24h: parseFloat(t.highPrice),
    low24h: parseFloat(t.lowPrice),
    volume24h: parseFloat(t.quoteVolume),
  }));
}

export async function fetchSymbols(): Promise<string[]> {
  const res = await safeFetch('/api/v3/exchangeInfo');
  if (!res.ok) throw new Error('Failed to load exchange info');
  const json = await res.json();
  return json.symbols
    .filter(
      (s: { status: string; quoteAsset: string }) =>
        s.status === 'TRADING' && s.quoteAsset === 'USDT',
    )
    .map((s: { symbol: string }) => s.symbol);
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  /** Number of decimal places implied by the symbol's PRICE_FILTER tickSize. */
  pricePrecision: number;
  /** Raw tick size as a number (e.g. 0.01). */
  tickSize: number;
}

/**
 * Derives the number of decimal places from a Binance tickSize string. For a
 * tickSize of "0.00001000" we want precision 5, for "0.01000000" we want 2,
 * for "1.00000000" we want 0. Using log10 keeps this robust against trailing
 * zeros and unusual sub-tenth ticks like "0.5" → precision 1.
 */
export function precisionFromTickSize(tickSize: string): number {
  const n = parseFloat(tickSize);
  if (!Number.isFinite(n) || n <= 0) return 8;
  return Math.max(0, -Math.floor(Math.log10(n)));
}

/** All TRADING-status symbols whose quote asset is USDT, with base-asset info. */
export async function fetchUsdtSymbolsInfo(): Promise<SymbolInfo[]> {
  const res = await safeFetch('/api/v3/exchangeInfo');
  if (!res.ok) throw new Error('Failed to load exchange info');
  const json = await res.json();
  return (json.symbols as Array<{
    symbol: string;
    status: string;
    quoteAsset: string;
    baseAsset: string;
    filters?: Array<{ filterType: string; tickSize?: string }>;
  }>)
    .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .map((s) => {
      const priceFilter = s.filters?.find((f) => f.filterType === 'PRICE_FILTER');
      const tickStr = priceFilter?.tickSize ?? '0.01';
      const tickSize = parseFloat(tickStr);
      const pricePrecision = precisionFromTickSize(tickStr);
      return {
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        pricePrecision,
        tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01,
      };
    });
}

/**
 * Fetches 24h ticker stats for *all* USDT pairs in a single request.
 * Binance's /ticker/24hr without a symbols param returns ~2000 entries
 * across every quote asset; we filter to USDT client-side.
 */
export async function fetchAllUsdtTickers(): Promise<Ticker[]> {
  const res = await safeFetch('/api/v3/ticker/24hr');
  if (!res.ok) {
    throw new Error(`Binance bulk ticker request failed: ${res.status}`);
  }
  const arr: Array<Record<string, string>> = await res.json();
  return arr
    .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
    .map((t) => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      priceChangePercent: parseFloat(t.priceChangePercent),
      high24h: parseFloat(t.highPrice),
      low24h: parseFloat(t.lowPrice),
      volume24h: parseFloat(t.quoteVolume),
    }));
}

/** Quick health check: ping each REST endpoint, return list of reachable ones. */
export async function diagnoseEndpoints(): Promise<
  { endpoint: string; ok: boolean; latencyMs?: number; error?: string }[]
> {
  const results = await Promise.all(
    REST_ENDPOINTS.map(async (ep) => {
      const start = Date.now();
      try {
        const res = await fetch(`${ep}/api/v3/ping`, { method: 'GET' });
        return {
          endpoint: ep,
          ok: res.ok,
          latencyMs: Date.now() - start,
          error: res.ok ? undefined : `HTTP ${res.status}`,
        };
      } catch (err) {
        return {
          endpoint: ep,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return results;
}

/* -------------------------------------------------------------------------- */
/*                              WebSocket Client                              */
/* -------------------------------------------------------------------------- */

export interface KlineUpdate {
  symbol: string;
  interval: Timeframe;
  candle: Candle;
  isFinal: boolean;
}

export interface TickerUpdate {
  symbol: string;
  price: number;
  priceChangePercent: number;
}

type CandleListener = (update: KlineUpdate) => void;
type TickerListener = (update: TickerUpdate) => void;
type ConnectionListener = (connected: boolean) => void;

interface Subscription {
  symbol: string;
  interval: Timeframe;
}

export class BinanceWebSocket {
  private ws: WebSocket | null = null;
  private subscriptions: Subscription[] = [];
  private candleListeners = new Set<CandleListener>();
  private tickerListeners = new Set<TickerListener>();
  private connectionListeners = new Set<ConnectionListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private endpointIndex = 0;
  private intentionallyClosed = false;
  private nextRequestId = 1;
  private connectedToBase: string | null = null;
  private hadSuccessfulConnection = false;

  constructor() {
    const sticky = loadStickyEndpoint(STORAGE_WS_KEY, WS_ENDPOINTS);
    if (sticky) {
      this.endpointIndex = WS_ENDPOINTS.indexOf(sticky as (typeof WS_ENDPOINTS)[number]);
      if (this.endpointIndex < 0) this.endpointIndex = 0;
    }
  }

  private get streams(): string[] {
    const klines = this.subscriptions.map(
      (s) => `${s.symbol.toLowerCase()}@kline_${s.interval}`,
    );
    const tickers = Array.from(
      new Set(this.subscriptions.map((s) => `${s.symbol.toLowerCase()}@ticker`)),
    );
    return [...klines, ...tickers];
  }

  setSubscriptions(subs: Subscription[]) {
    // Idempotent: if the requested set matches what we already have AND the
    // socket is open/opening, do nothing. React StrictMode (dev) double-mounts
    // effects, so without this guard the first paint produces a phantom
    // reconnect storm even though nothing actually changed.
    if (
      this.subsEqual(this.subscriptions, subs) &&
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.subscriptions = subs.slice();
    if (this.subscriptions.length === 0) {
      this.disconnect();
      return;
    }
    this.reconnect();
  }

  private subsEqual(a: Subscription[], b: Subscription[]): boolean {
    if (a.length !== b.length) return false;
    const key = (s: Subscription) => `${s.symbol}|${s.interval}`;
    const aSet = new Set(a.map(key));
    for (const s of b) {
      if (!aSet.has(key(s))) return false;
    }
    return true;
  }

  addSubscription(sub: Subscription) {
    if (
      this.subscriptions.some(
        (s) => s.symbol === sub.symbol && s.interval === sub.interval,
      )
    ) {
      return;
    }
    this.subscriptions.push(sub);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        method: 'SUBSCRIBE',
        params: [
          `${sub.symbol.toLowerCase()}@kline_${sub.interval}`,
          `${sub.symbol.toLowerCase()}@ticker`,
        ],
        id: this.nextRequestId++,
      });
    } else {
      this.reconnect();
    }
  }

  removeSubscription(sub: Subscription) {
    this.subscriptions = this.subscriptions.filter(
      (s) => !(s.symbol === sub.symbol && s.interval === sub.interval),
    );
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        method: 'UNSUBSCRIBE',
        params: [`${sub.symbol.toLowerCase()}@kline_${sub.interval}`],
        id: this.nextRequestId++,
      });
    }
  }

  onCandle(listener: CandleListener) {
    this.candleListeners.add(listener);
    return () => this.candleListeners.delete(listener);
  }

  onTicker(listener: TickerListener) {
    this.tickerListeners.add(listener);
    return () => this.tickerListeners.delete(listener);
  }

  onConnection(listener: ConnectionListener) {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /**
   * Detach all handlers from the current socket *before* closing it, then
   * drop the reference. Necessary because `WebSocket.close()` fires `onclose`
   * asynchronously — if we leave the handler live, it runs against an already
   * mutated `this` (new `intentionallyClosed`, new `hadSuccessfulConnection`,
   * possibly even a new `this.ws`) and pollutes state: spurious
   * `notifyConnection(false)`, unwanted `scheduleReconnect()`, endpoint
   * rotation away from a perfectly good URL, etc.
   */
  private killSocket() {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private reconnect() {
    // Explicit fresh connection — not a retry. Reset the backoff counter so we
    // don't inherit attempts from earlier failed sessions and end up sitting
    // in a 8-30s exponential wait when the user is just switching symbols.
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.killSocket();
    this.intentionallyClosed = false;
    this.connect();
  }

  connect() {
    if (typeof window === 'undefined') return;
    if (this.subscriptions.length === 0) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const base = WS_ENDPOINTS[this.endpointIndex] ?? WS_ENDPOINTS[0];
    const url = `${base}?streams=${this.streams.join('/')}`;
    this.connectedToBase = base;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('[binance] WS construct failed:', err);
      this.rotateEndpoint();
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.hadSuccessfulConnection = true;
      saveStickyEndpoint(STORAGE_WS_KEY, base);
      this.startPing();
      this.notifyConnection(true);
    };

    this.ws.onclose = () => {
      this.stopPing();
      this.notifyConnection(false);
      if (!this.hadSuccessfulConnection) this.rotateEndpoint();
      if (!this.intentionallyClosed) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose follows; rotation/reconnect handled there.
    };

    this.ws.onmessage = (ev) => this.handleMessage(ev.data);
  }

  private rotateEndpoint() {
    this.endpointIndex = (this.endpointIndex + 1) % WS_ENDPOINTS.length;
  }

  disconnect(intentional = true) {
    this.intentionallyClosed = intentional;
    // Intentional teardown is not a failure — reset the backoff counter so the
    // next session starts at a 1s delay if it ever needs to retry.
    if (intentional) this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    // Kill the socket with handlers detached. If we left the live onclose
    // attached, it would fire asynchronously, potentially after the caller has
    // already started a new session — and would erroneously notify connection
    // loss, rotate endpoints, or schedule a reconnect we didn't ask for.
    this.killSocket();
    if (intentional) this.notifyConnection(false);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.send({
            method: 'LIST_SUBSCRIPTIONS',
            id: this.nextRequestId++,
          });
        } catch {
          /* ignore */
        }
      }
    }, 30_000);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private send(payload: unknown) {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.warn('[binance] send failed:', err);
    }
  }

  private handleMessage(raw: string) {
    let parsed: { stream?: string; data?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || !parsed.stream || !parsed.data) return;

    const stream = parsed.stream as string;
    const data = parsed.data as Record<string, unknown>;

    if (stream.includes('@kline_')) {
      const k = data.k as Record<string, unknown> | undefined;
      if (!k) return;
      const symbol = String(data.s ?? '').toUpperCase();
      const interval = String(k.i) as Timeframe;
      const candle: Candle = {
        time: Math.floor(Number(k.t) / 1000),
        open: parseFloat(k.o as string),
        high: parseFloat(k.h as string),
        low: parseFloat(k.l as string),
        close: parseFloat(k.c as string),
        volume: parseFloat(k.v as string),
      };
      const update: KlineUpdate = {
        symbol,
        interval,
        candle,
        isFinal: Boolean(k.x),
      };
      this.candleListeners.forEach((cb) => {
        try {
          cb(update);
        } catch (err) {
          console.error('[binance] candle listener error:', err);
        }
      });
      return;
    }

    if (stream.endsWith('@ticker')) {
      const update: TickerUpdate = {
        symbol: String(data.s ?? '').toUpperCase(),
        price: parseFloat(String(data.c ?? '0')),
        priceChangePercent: parseFloat(String(data.P ?? '0')),
      };
      this.tickerListeners.forEach((cb) => {
        try {
          cb(update);
        } catch (err) {
          console.error('[binance] ticker listener error:', err);
        }
      });
    }
  }

  private notifyConnection(connected: boolean) {
    this.connectionListeners.forEach((cb) => {
      try {
        cb(connected);
      } catch (err) {
        console.error('[binance] connection listener error:', err);
      }
    });
  }

  /** For diagnostics. */
  getActiveEndpoint(): string | null {
    return this.connectedToBase;
  }
}

let singleton: BinanceWebSocket | null = null;

export function getBinanceWS(): BinanceWebSocket {
  if (!singleton) singleton = new BinanceWebSocket();
  return singleton;
}

export { REST_ENDPOINTS, WS_ENDPOINTS };
