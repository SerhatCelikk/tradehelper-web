import { getCachedKlines } from './klinesCache';
import { runOptimization, type OptimizerHorizon } from './optimizer';
import { loadOptimization, saveOptimization } from './optimizerStorage';
import type { IndicatorConfig, IndicatorParams, Timeframe } from './types';

/**
 * Tools that the chat assistant can invoke. Each tool has a TypeScript
 * "executor" that runs client-side against the app's store — the API route
 * only declares the function signatures, it never executes anything itself.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionContext {
  symbol: string;
  timeframe: Timeframe;
  /** Store action to apply an optimizer result back onto the indicator panel. */
  replaceOrAddIndicator: (
    type: IndicatorConfig['type'],
    params: IndicatorParams,
    timeframe: Timeframe,
  ) => string;
  /** Set of known Binance crypto symbols — feeds `getCachedKlines` so it
   *  picks the right data source (Binance vs Yahoo). */
  cryptoUniverse: ReadonlySet<string>;
}

export interface ToolResult {
  success: boolean;
  /** Free-form error message — shown to the model so it can explain to user. */
  error?: string;
  /** Payload the model uses to compose its final natural-language reply. */
  data?: unknown;
}

const HORIZON_LABELS: Record<OptimizerHorizon, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

export async function executeChatTool(
  call: ToolCall,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  switch (call.name) {
    case 'applyBestSettingsForHorizon':
      return applyBestSettingsForHorizon(call.args, ctx);
    case 'runOptimizerForHorizon':
      return runOptimizerForHorizon(call.args, ctx);
    default:
      return {
        success: false,
        error: `Unknown tool: ${call.name}`,
      };
  }
}

function applyBestSettingsForHorizon(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): ToolResult {
  const horizon = args.horizon as OptimizerHorizon | undefined;
  if (!horizon || !HORIZON_LABELS[horizon]) {
    return {
      success: false,
      error: `Invalid horizon "${String(args.horizon)}". Expected daily / weekly / monthly / yearly.`,
    };
  }

  const saved = loadOptimization(ctx.symbol, ctx.timeframe, horizon);
  if (!saved) {
    return {
      success: false,
      error:
        `No saved optimizer run for ${ctx.symbol} on ${ctx.timeframe} at the ${HORIZON_LABELS[horizon]} horizon. ` +
        `Tell the user to click the Optimize button in the Indicators tab to generate one first.`,
    };
  }

  const applied: Array<{
    type: string;
    params: Record<string, unknown>;
    timeframe: Timeframe;
    testReturnPct: number;
    trades: number;
    winRatePct: number;
  }> = [];

  for (const result of Object.values(saved.bestPerType)) {
    if (!result) continue;
    ctx.replaceOrAddIndicator(
      result.type,
      result.params,
      saved.timeframe,
    );
    applied.push({
      type: result.type,
      params: result.params as Record<string, unknown>,
      timeframe: saved.timeframe,
      testReturnPct: result.outSample?.totalReturnPercent ?? 0,
      trades: result.outSample?.numberOfTrades ?? 0,
      winRatePct: result.outSample?.winRate ?? 0,
    });
  }

  if (applied.length === 0) {
    return {
      success: false,
      error: `The saved ${HORIZON_LABELS[horizon]} run for ${ctx.symbol} on ${ctx.timeframe} has no top-per-type results.`,
    };
  }

  return {
    success: true,
    data: {
      symbol: ctx.symbol,
      timeframe: saved.timeframe,
      horizon: HORIZON_LABELS[horizon],
      runAt: saved.runAt,
      applied,
      note:
        "The indicator performance card will recompute its D/W/M stats automatically — no further user action needed.",
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                          runOptimizerForHorizon                            */
/* -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;
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

const HORIZON_DAYS_LOCAL: Record<OptimizerHorizon, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  yearly: 365,
};

/**
 * Same policy as `useOptimizer.fetchRangeFor` — kept in sync deliberately
 * so the chat-driven run produces identical results to the modal-driven
 * one. Aim for ≥4× the horizon, ≥600 bars at this timeframe, capped at 3y.
 */
function fetchRangeFor(tf: Timeframe, horizon: OptimizerHorizon): number {
  const tfMs = TIMEFRAME_MS[tf] ?? TIMEFRAME_MS['4h'];
  const horizonMs = HORIZON_DAYS_LOCAL[horizon] * DAY_MS;
  const target = horizonMs * 4;
  const minByCandleCount = 600 * tfMs;
  return Math.min(
    3 * 365 * DAY_MS,
    Math.max(60 * DAY_MS, target, minByCandleCount),
  );
}

/**
 * Runs the optimizer for the user's current symbol+timeframe at the chosen
 * horizon and persists the result the same way the modal does. Takes
 * ~15-30s; the assistant should warn the user up front. After this resolves
 * the assistant can chain into `applyBestSettingsForHorizon` to actually
 * push the winners onto the page.
 */
async function runOptimizerForHorizon(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const horizon = args.horizon as OptimizerHorizon | undefined;
  if (!horizon || !HORIZON_LABELS[horizon]) {
    return {
      success: false,
      error: `Invalid horizon "${String(args.horizon)}". Expected daily / weekly / monthly / yearly.`,
    };
  }

  try {
    const candles = await getCachedKlines(
      ctx.symbol,
      ctx.timeframe,
      fetchRangeFor(ctx.timeframe, horizon),
      ctx.cryptoUniverse,
    );

    if (candles.length < 90) {
      return {
        success: false,
        error:
          `Not enough history for ${ctx.symbol} on ${ctx.timeframe} ` +
          `(only ${candles.length} bars). Suggest a longer timeframe or a different symbol.`,
      };
    }

    const final = await runOptimization(
      candles,
      { timeframe: ctx.timeframe, horizon },
    );

    if (final.topResults.length === 0) {
      return {
        success: false,
        error:
          `Optimizer finished but produced no usable results for ${ctx.symbol} ` +
          `on ${ctx.timeframe} at the ${HORIZON_LABELS[horizon]} horizon.`,
      };
    }

    saveOptimization(ctx.symbol, ctx.timeframe, horizon, {
      runAt: new Date().toISOString(),
      metric: 'return',
      candleCount: candles.length,
      trainCandles: final.diagnostics.trainCandles,
      testCandles: final.diagnostics.testCandles,
      results: final.topResults,
      bestPerType: final.bestPerType,
    });

    const summary = Object.values(final.bestPerType)
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => ({
        type: r.type,
        params: r.params as Record<string, unknown>,
        testReturnPct: r.outSample?.totalReturnPercent ?? 0,
        trades: r.outSample?.numberOfTrades ?? 0,
        winRatePct: r.outSample?.winRate ?? 0,
      }));

    return {
      success: true,
      data: {
        symbol: ctx.symbol,
        timeframe: ctx.timeframe,
        horizon: HORIZON_LABELS[horizon],
        candleCount: candles.length,
        trainCandles: final.diagnostics.trainCandles,
        testCandles: final.diagnostics.testCandles,
        bestPerType: summary,
        note:
          "Optimizer results are now saved. You can chain into " +
          "`applyBestSettingsForHorizon` to push these onto the page.",
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Optimizer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Short status label shown while the tool is running, before the model's
 * follow-up text reply lands.
 */
export function toolStatusLabel(call: ToolCall): string {
  if (call.name === 'applyBestSettingsForHorizon') {
    const horizon = call.args.horizon as string | undefined;
    const label = horizon && HORIZON_LABELS[horizon as OptimizerHorizon];
    return label
      ? `Applying ${label} best settings…`
      : 'Applying best settings…';
  }
  if (call.name === 'runOptimizerForHorizon') {
    const horizon = call.args.horizon as string | undefined;
    const label = horizon && HORIZON_LABELS[horizon as OptimizerHorizon];
    return label
      ? `Running ${label} optimizer (~15-30s)…`
      : 'Running optimizer (~15-30s)…';
  }
  return 'Working on it…';
}
