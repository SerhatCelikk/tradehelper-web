import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MODEL = 'gemini-flash-latest';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/* -------------------------------------------------------------------------- */
/*                          Wire types (client ↔ server)                      */
/* -------------------------------------------------------------------------- */

interface APIMessage {
  role: 'user' | 'assistant' | 'assistant_tool' | 'tool';
  /** For role 'user' | 'assistant'. */
  content?: string;
  /** For role 'assistant_tool' (the model called a function last turn) and
   *  for role 'tool' (the client-executed function result). */
  name?: string;
  args?: Record<string, unknown>;
  response?: unknown;
  /** Provenance token Gemini attaches to its own functionCall parts. We
   *  must echo it back unchanged when the function call appears in the
   *  history we send next — newer Gemini API versions reject the request
   *  with a 400 if it's missing. See:
   *  https://ai.google.dev/gemini-api/docs/thought-signatures */
  thoughtSignature?: string;
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
  /** Which horizons have a saved optimizer run for this symbol+timeframe.
   *  Lets the assistant tell the user "I already have a daily run cached"
   *  vs "you'll need to optimize first". */
  availableOptimizerHorizons?: string[];
}

interface ChatRequest {
  messages: APIMessage[];
  context?: ChatContext;
}

/* -------------------------------------------------------------------------- */
/*                              Tool declarations                             */
/* -------------------------------------------------------------------------- */

/**
 * Gemini-side function declarations. The model decides whether to call
 * these based on the user's wording; we surface the call to the client,
 * which executes it against the app state and posts the result back.
 */
const TOOL_FUNCTIONS = {
  functionDeclarations: [
    {
      name: 'applyBestSettingsForHorizon',
      description:
        "Apply the user's saved optimizer top-per-indicator settings " +
        '(RSI, MACD, BBANDS, SMA, EMA — one of each type) onto the ' +
        "Indicators panel for the user's current symbol+timeframe at the " +
        'chosen horizon. The indicator performance cards (Daily/Weekly/' +
        'Monthly) auto-recompute after this runs. Use when the user asks ' +
        'something like "apply the best daily indicator settings", ' +
        '"haftalık en iyi ayarları getir", "günün en iyi indikatörlerini ' +
        'kur ve hesapla", or any phrasing that means "make the page reflect ' +
        'the optimizer\'s best settings for that horizon". If no saved ' +
        'optimizer run exists for this combo the tool will return an error — ' +
        "you can then call `runOptimizerForHorizon` to generate one and " +
        'chain back into this tool to apply it.',
      parameters: {
        type: 'OBJECT',
        properties: {
          horizon: {
            type: 'STRING',
            enum: ['daily', 'weekly', 'monthly', 'yearly'],
            description:
              'Which horizon to load the optimizer\'s best settings from.',
          },
        },
        required: ['horizon'],
      },
    },
    {
      name: 'runOptimizerForHorizon',
      description:
        'Run the parameter optimizer for the user\'s current symbol+' +
        'timeframe at the given horizon and SAVE the results. Takes 15-30 ' +
        'seconds. Call this when (a) `applyBestSettingsForHorizon` failed ' +
        'because no saved run exists yet, or (b) the user explicitly asks ' +
        'to "re-scan / re-run / optimize / tara / optimize et" the indicators. ' +
        'IMPORTANT: tell the user up front that the scan will take 15-30s ' +
        'before invoking this. After the optimizer finishes you should ' +
        'usually chain into `applyBestSettingsForHorizon` to put the new ' +
        'winners onto the page — unless the user only asked for a list.',
      parameters: {
        type: 'OBJECT',
        properties: {
          horizon: {
            type: 'STRING',
            enum: ['daily', 'weekly', 'monthly', 'yearly'],
            description:
              'Which horizon to optimize for. Test window covers the last ' +
              '1 / 7 / 30 / 365 days respectively.',
          },
        },
        required: ['horizon'],
      },
    },
  ],
};

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
    '## Actions (function calling)',
    '- You have two available tools:',
    '  - `applyBestSettingsForHorizon(horizon)` — applies the SAVED optimizer\'s top setting for each indicator type (RSI, MACD, BBANDS, SMA, EMA) onto the user\'s current symbol+timeframe at the requested horizon. The performance cards auto-recompute afterwards. Instant.',
    '  - `runOptimizerForHorizon(horizon)` — runs the optimizer over the user\'s current symbol+timeframe and saves the result. **Takes 15-30 seconds.** Tell the user it\'ll take a moment before calling.',
    '- **Call these tools whenever the user asks to "apply / set up / kur / getir / uygula / hesapla / optimize et" the best settings for a horizon** (daily / weekly / monthly / yearly). Do not just describe the settings — actually invoke the tool so the page changes.',
    '- **Chaining pattern**: if `applyBestSettingsForHorizon` returns an error like "No saved optimizer run", do not give up. Tell the user "I\'ll run the optimizer first — this takes about 30 seconds", then call `runOptimizerForHorizon(horizon)`, and once it succeeds chain back into `applyBestSettingsForHorizon(horizon)` to push the new winners onto the page. Finally summarise in one short paragraph.',
    '- Each tool returns the list of applied/found indicators with their realised returns. After success, briefly summarise in plain language (no need to dump every parameter).',
    '- If the user only wants to *see* the best settings (not apply), you can still call `runOptimizerForHorizon` to get fresh numbers and then describe the results instead of chaining into apply.',
    '',
    '## News and current events',
    '- Your training data is months to years out of date. **Never** answer "what\'s happening with X?" / "any news?" from memory.',
    '- **Always** invoke Google Search for any question about prices, news, events, sentiment, regulation, earnings, hacks, listings, partnerships, or anything time-sensitive.',
    `- Prioritise sources from the **last 24–72 hours**. Today is ${today}. Cite the date (or "today", "yesterday", "X hours ago") so the user can judge freshness.`,
    '- Mention 2–4 distinct headlines/angles instead of one block of paraphrase. Only cite items you actually retrieved.',
    '',
    '## Strategy advice',
    '- Reference the user\'s configured indicators and recent optimizer findings when they\'re relevant — name the indicator, its parameters, and the realised return.',
    '- Tell the user *how* to use specific indicators for specific horizons. Example: "For monthly return on @BTCUSDT the optimizer found **RSI(14, 25, 75)** at +12.4% on test — want me to apply it? (I can.)"',
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

  if (ctx.customStrategy && ctx.customStrategy.indicators.length > 0) {
    const parts = ctx.customStrategy.indicators
      .map((i) => `${i.type}@${i.timeframe}`)
      .join(' + ');
    lines.push(`- Custom "My Strategy" (${ctx.customStrategy.logic}): ${parts}`);
  }

  if (
    ctx.availableOptimizerHorizons &&
    ctx.availableOptimizerHorizons.length > 0
  ) {
    lines.push(
      `- Saved optimizer runs available for: ${ctx.availableOptimizerHorizons.join(', ')}`,
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

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  /** Opaque provenance token for thought-step ↔ function-call binding. */
  thoughtSignature?: string;
}

function buildContents(messages: APIMessage[]): GeminiContent[] {
  return messages.map((m): GeminiContent => {
    switch (m.role) {
      case 'user':
        return { role: 'user', parts: [{ text: m.content ?? '' }] };
      case 'assistant':
        return { role: 'model', parts: [{ text: m.content ?? '' }] };
      case 'assistant_tool': {
        const part: GeminiPart = {
          functionCall: { name: m.name ?? '', args: m.args ?? {} },
        };
        // Echo the original thought signature back so Gemini accepts the
        // history. Omitting it triggers a 400 with the docs link in the
        // error body.
        if (m.thoughtSignature) part.thoughtSignature = m.thoughtSignature;
        return { role: 'model', parts: [part] };
      }
      case 'tool':
        return {
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: m.name ?? '',
                response: m.response ?? {},
              },
            },
          ],
        };
    }
  });
}

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
  const contents = buildContents(body.messages);

  // Tools strategy: try with BOTH Google Search and function declarations.
  // Some Gemini setups reject the combination, in which case the retry uses
  // just function declarations (actions matter more here than fresh search
  // — and search-only news answers can use a separate non-tool path).
  const baseBody = {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  };

  const fullTools = {
    ...baseBody,
    tools: [{ googleSearch: {} }, TOOL_FUNCTIONS],
  };
  const functionsOnly = {
    ...baseBody,
    tools: [TOOL_FUNCTIONS],
  };

  let data: GeminiResponse | null = null;
  let lastError = '';

  for (const variant of [fullTools, functionsOnly, baseBody]) {
    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
        },
        body: JSON.stringify(variant),
      });
      if (resp.ok) {
        data = (await resp.json()) as GeminiResponse;
        break;
      }
      lastError = `Gemini ${resp.status}: ${truncate(await resp.text(), 400)}`;
    } catch (err) {
      lastError = `Network error: ${String(err)}`;
    }
  }

  if (!data) {
    return NextResponse.json({ error: lastError || 'Gemini call failed' }, { status: 502 });
  }

  return NextResponse.json(extractResponse(data));
}

/* -------------------------------------------------------------------------- */
/*                              Response parsing                              */
/* -------------------------------------------------------------------------- */

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
}

interface ExtractedResponse {
  toolCall: {
    name: string;
    args: Record<string, unknown>;
    /** Carry the signature through so the client can echo it back on the
     *  follow-up request after executing the tool. */
    thoughtSignature?: string;
  } | null;
  reply: string;
  grounding: {
    queries: string[];
    sources: Array<{ title: string; uri: string }>;
  } | null;
  finishReason: string | null;
  model: string;
}

function extractResponse(data: GeminiResponse): ExtractedResponse {
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  // Prefer function call when both are present — the model is telling us
  // "first execute this, then I'll wrap up with text on the next turn".
  const fcPart = parts.find((p) => p.functionCall);
  if (fcPart?.functionCall) {
    return {
      toolCall: {
        name: fcPart.functionCall.name,
        args: fcPart.functionCall.args ?? {},
        thoughtSignature: fcPart.thoughtSignature,
      },
      reply: parts
        .filter((p) => p.text)
        .map((p) => p.text ?? '')
        .join('')
        .trim(),
      grounding: extractGroundingSummary(candidate),
      finishReason: candidate?.finishReason ?? null,
      model: MODEL,
    };
  }

  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  return {
    toolCall: null,
    reply: text,
    grounding: extractGroundingSummary(candidate),
    finishReason: candidate?.finishReason ?? null,
    model: MODEL,
  };
}

type GeminiCandidate = NonNullable<GeminiResponse['candidates']>[number];

function extractGroundingSummary(
  candidate: GeminiCandidate | undefined,
): ExtractedResponse['grounding'] {
  try {
    const meta = candidate?.groundingMetadata;
    if (!meta) return null;
    const queries = meta.webSearchQueries ?? [];
    const sources: Array<{ title: string; uri: string }> = [];
    for (const c of meta.groundingChunks ?? []) {
      const web = c.web;
      if (web?.uri) {
        sources.push({ title: web.title ?? web.uri, uri: web.uri });
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
