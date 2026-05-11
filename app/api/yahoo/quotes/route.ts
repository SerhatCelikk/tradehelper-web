import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
// Light cache: refresh-in-the-background within 15s, then revalidate.
export const revalidate = 15;

interface QuoteOut {
  price: number;
  change: number;
  volume: number;
  currency?: string;
}

// Yahoo's edge cluster rejects requests without a browser-ish User-Agent.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchYahooMeta(symbol: string): Promise<QuoteOut | null> {
  // We use the v8/chart endpoint (no crumb/cookie required) and read the
  // `meta` block, which carries `regularMarketPrice` + `chartPreviousClose`.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    next: { revalidate: 15 },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
  const price = meta.regularMarketPrice as number;
  const prev =
    typeof meta.chartPreviousClose === 'number'
      ? (meta.chartPreviousClose as number)
      : typeof meta.previousClose === 'number'
        ? (meta.previousClose as number)
        : price;
  const change = prev > 0 ? ((price - prev) / prev) * 100 : 0;
  return {
    price,
    change,
    volume: typeof meta.regularMarketVolume === 'number' ? meta.regularMarketVolume : 0,
    currency: typeof meta.currency === 'string' ? meta.currency : undefined,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('symbols') ?? '';
  const symbols = Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );

  if (symbols.length === 0) {
    return NextResponse.json({ quotes: {} });
  }

  // Cap to a sensible size — keeps Yahoo happy and our latency bounded.
  const MAX = 64;
  const slice = symbols.slice(0, MAX);

  const entries = await Promise.all(
    slice.map(async (sym) => {
      try {
        const quote = await fetchYahooMeta(sym);
        return [sym, quote] as const;
      } catch {
        return [sym, null] as const;
      }
    }),
  );

  const quotes: Record<string, QuoteOut> = {};
  for (const [sym, q] of entries) {
    if (q) quotes[sym] = q;
  }

  return NextResponse.json(
    { quotes },
    {
      headers: {
        // Browsers may revalidate before the server-side cache expires; this
        // lets them serve a slightly stale price for up to 10s before retrying.
        'Cache-Control': 'public, max-age=10, stale-while-revalidate=30',
      },
    },
  );
}
