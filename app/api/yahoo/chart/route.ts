import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const revalidate = 15;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Yahoo only accepts a fixed enum of intervals / ranges.
const ALLOWED_INTERVALS = new Set([
  '1m',
  '2m',
  '5m',
  '15m',
  '30m',
  '60m',
  '90m',
  '1h',
  '1d',
  '5d',
  '1wk',
  '1mo',
  '3mo',
]);

const ALLOWED_RANGES = new Set([
  '1d',
  '5d',
  '1mo',
  '3mo',
  '6mo',
  '1y',
  '2y',
  '5y',
  '10y',
  'ytd',
  'max',
]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get('symbol')?.trim() ?? '';
  const interval = (url.searchParams.get('interval') ?? '1d').trim();
  const range = (url.searchParams.get('range') ?? '1mo').trim();

  if (!symbol) {
    return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });
  }
  if (!ALLOWED_INTERVALS.has(interval)) {
    return NextResponse.json({ error: 'Invalid interval' }, { status: 400 });
  }
  if (!ALLOWED_RANGES.has(range)) {
    return NextResponse.json({ error: 'Invalid range' }, { status: 400 });
  }

  const params = new URLSearchParams({
    interval,
    range,
    includePrePost: 'false',
  });
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?${params}`;

  let yahoo: Response;
  try {
    yahoo = await fetch(target, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      next: { revalidate: 15 },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Upstream fetch failed', detail: String(err) },
      { status: 502 },
    );
  }

  if (!yahoo.ok) {
    return NextResponse.json(
      { error: `Yahoo upstream ${yahoo.status}` },
      { status: 502 },
    );
  }

  const data = await yahoo.json();
  const result = data?.chart?.result?.[0];
  if (!result) {
    return NextResponse.json({ candles: [], meta: null });
  }

  const timestamps: number[] = Array.isArray(result.timestamp)
    ? result.timestamp
    : [];
  const quote = result.indicators?.quote?.[0];
  if (!quote) {
    return NextResponse.json({ candles: [], meta: result.meta ?? null });
  }

  const opens: (number | null)[] = quote.open ?? [];
  const highs: (number | null)[] = quote.high ?? [];
  const lows: (number | null)[] = quote.low ?? [];
  const closes: (number | null)[] = quote.close ?? [];
  const volumes: (number | null)[] = quote.volume ?? [];

  const candles: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      time: timestamps[i],
      open: o,
      high: h,
      low: l,
      close: c,
      volume: volumes[i] ?? 0,
    });
  }

  return NextResponse.json(
    { candles, meta: result.meta ?? null },
    {
      headers: {
        'Cache-Control': 'public, max-age=10, stale-while-revalidate=60',
      },
    },
  );
}
