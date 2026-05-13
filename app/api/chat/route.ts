import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MODEL = 'gemini-flash-latest';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface IndicatorContext {
  type: string;
  params: Record<string, unknown>;
  timeframe: string;
  enabled: boolean;
}

interface OptimizerHint {
  horizon: string;
  indicatorType: string;
  params: Record<string, unknown>;
  testReturn: number;
  trades: number;
  winRate: number;
}

interface ChatContext {
  symbol?: string;
  timeframe?: string;
  assetClass?: 'crypto' | 'stock' | 'commodity';
  lastPrice?: number;
  priceChange24h?: number;
  indicators?: IndicatorContext[];
  customStrategy?: {
    indicators: Array<{ type: string; timeframe: string; params: Record<string, unknown> }>;
    logic: 'AND' | 'OR';
  };
  optimizerHints?: OptimizerHint[];
  knownSymbols?: string[];
}

interface ChatRequest {
  messages: ChatMessage[];
  context?: ChatContext;
}

/* -------------------------------------------------------------------------- */
/*                              System prompt                                 */
/* -------------------------------------------------------------------------- */

function buildSystemInstruction(ctx: ChatContext | undefined): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `You are **TradeHelper Assistant** — an in-app AI helping a trader analyse crypto pairs, US equities, and commodity futures. Today's date is **${today}**.`,
    '',
    '## How to behave',
    '- Respond in the user\'s language (Turkish or English, mirroring their phrasing). Keep replies concise, friendly, and trading-focused.',
    '- Use Markdown sparingly: short paragraphs, occasional bullet lists, **bold** for key numbers and tickers.',
    '- Tickers in messages start with `@` — `@BTCUSDT` is crypto (Binance pair), `@AAPL` is a US stock, `@GC=F` is a commodity future (gold). Resolve them when answering.',
    '',
    '## News and current events — IMPORTANT',
    '- Your training data is months to years out of date. **Never** answer a "what\'s happening with X?" / "any news?" question from memory.',
    '- **Always** invoke Google Search for any question about prices, news, events, sentiment, regulation, earnings, hacks, listings, partnerships, or anything time-sensitive.',
    `- Prioritise sources from the **last 24–72 hours**, ideally within the last few hours for breaking developments. Today is ${today}.`,
    '- Cite the **date** (or "today", "yesterday", "X hours ago") in your answer so the user can judge freshness. If your top sources are older than 7 days, say so explicitly and explain you couldn\'t find more recent material.',
    '- Mention 2–4 distinct headlines/angles instead of one block of paraphrase, and only cite items you actually retrieved.',
    '',
    '## Strategy advice',
    '- Reference the user\'s configured indicators and recent optimizer findings when they\'re relevant — name the indicator, its parameters, and the realised return.',
    '- Tell the user *how* to use specific indicators for specific horizons. Example: "For monthly return on @BTCUSDT the optimizer found **RSI(14, 25, 75)** at +12.4% on test — apply it from the Indicators tab and toggle focus mode to see the long/short zones."',
    '- Never invent prices, trades, or news. If you don\'t know, say so.',
    '',
  ];

  if (!ctx) {
    return lines.join('\n');
  }

  lines.push('**Current app context:**');
  if (ctx.symbol) {
    const assetTag = ctx.assetClass ? ` (${ctx.assetClass})` : '';
    lines.push(`- Selected symbol: **${ctx.symbol}**${assetTag}`);
  }
  if (ctx.timeframe) lines.push(`- Chart timeframe: **${ctx.timeframe}**`);
  if (typeof ctx.lastPrice === 'number' && Number.isFinite(ctx.lastPrice)) {
    const pct =
      typeof ctx.priceChange24h === 'number'
        ? ` (${ctx.priceChange24h >= 0 ? '+' : ''}${ctx.priceChange24h.toFixed(2)}% 24h)`
        : '';
    lines.push(`- Last price: ${ctx.lastPrice}${pct}`);
  }

  if (ctx.indicators && ctx.indicators.length > 0) {
    lines.push('- Indicators configured:');
    for (const ind of ctx.indicators) {
      const e = ind.enabled ? ' [chart-enabled]' : '';
      lines.push(`  - ${ind.type} @ ${ind.timeframe} — ${JSON.stringify(ind.params)}${e}`);
    }
  }

  if (
    ctx.customStrategy &&
    ctx.customStrategy.indicators.length > 0
  ) {
    const parts = ctx.customStrategy.indicators
      .map((i) => `${i.type}@${i.timeframe}`)
      .join(' + ');
    lines.push(
      `- Custom "My Strategy" (${ctx.customStrategy.logic}): ${parts}`,
    );
  }

  if (ctx.optimizerHints && ctx.optimizerHints.length > 0) {
    lines.push('- Recent optimizer findings (best per horizon):');
    for (const h of ctx.optimizerHints) {
      lines.push(
        `  - ${h.horizon}: ${h.indicatorType} ${JSON.stringify(h.params)} → ${h.testReturn >= 0 ? '+' : ''}${h.testReturn.toFixed(2)}% on test, ${h.trades} trades, ${h.winRate.toFixed(0)}% win`,
      );
    }
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*                              Gemini request                                */
/* -------------------------------------------------------------------------- */

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          'GEMINI_API_KEY is missing on the server. Add it to .env.local and restart the dev server.',
      },
      { status: 500 },
    );
  }

  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { error: 'messages array required' },
      { status: 400 },
    );
  }

  const systemText = buildSystemInstruction(body.context);
  const contents = body.messages.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  }));

  // Two-pass strategy: first attempt enables Google Search grounding so the
  // assistant can answer "what's the news on $X today?" with real sources.
  // If the model rejects the tool (some endpoints / regions / model versions
  // refuse), retry without the tool — better degraded answer than 500.
  const baseBody = {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents,
    generationConfig: {
      temperature: 0.7,
      // Bumped from 1024 — long answers (news round-ups with sources +
      // strategy explanations) were getting truncated mid-sentence on the
      // smaller cap.
      maxOutputTokens: 8192,
    },
  };

  // Gemini's v1beta REST surface expects camelCase tool keys (the curl
  // examples in older docs use snake_case but the actual API silently
  // ignores unknown tool keys, falling back to ungrounded responses
  // sourced from stale training data — which is why news answers were
  // years out of date until we fixed this).
  const withTools = {
    ...baseBody,
    tools: [{ googleSearch: {} }],
  };

  let resp: Response;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': apiKey,
      },
      body: JSON.stringify(withTools),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Network error reaching Gemini: ${String(err)}` },
      { status: 502 },
    );
  }

  if (!resp.ok) {
    // Retry without tools if the tool block is the cause.
    try {
      const retry = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
        },
        body: JSON.stringify(baseBody),
      });
      if (retry.ok) {
        const data = await retry.json();
        return NextResponse.json({
          reply: extractReply(data),
          grounding: null,
          model: MODEL,
        });
      }
      const text = await retry.text();
      return NextResponse.json(
        { error: `Gemini ${retry.status}: ${truncate(text, 400)}` },
        { status: 502 },
      );
    } catch (err) {
      return NextResponse.json(
        { error: `Gemini call failed: ${String(err)}` },
        { status: 502 },
      );
    }
  }

  const data = await resp.json();
  return NextResponse.json({
    reply: extractReply(data),
    grounding: extractGroundingSummary(data),
    model: MODEL,
  });
}

/* -------------------------------------------------------------------------- */
/*                                Helpers                                     */
/* -------------------------------------------------------------------------- */

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{
        web?: { uri?: string; title?: string };
      }>;
    };
  }>;
}

function extractReply(data: GeminiResponse): string {
  try {
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) return '';
    return parts.map((p) => p.text ?? '').join('').trim();
  } catch {
    return '';
  }
}

interface GroundingSummary {
  queries: string[];
  sources: Array<{ title: string; uri: string }>;
}

function extractGroundingSummary(data: GeminiResponse): GroundingSummary | null {
  try {
    const meta = data.candidates?.[0]?.groundingMetadata;
    if (!meta) return null;
    const queries = meta.webSearchQueries ?? [];
    const sources: Array<{ title: string; uri: string }> = [];
    for (const c of meta.groundingChunks ?? []) {
      const web = c.web;
      if (web?.uri) {
        sources.push({
          title: web.title ?? web.uri,
          uri: web.uri,
        });
      }
    }
    if (queries.length === 0 && sources.length === 0) return null;
    return { queries, sources };
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
