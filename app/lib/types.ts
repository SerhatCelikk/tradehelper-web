export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  symbol: string;
  price: number;
  priceChangePercent: number;
  high24h: number;
  low24h: number;
  volume24h: number;
}

export type Timeframe =
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '4h'
  | '1d'
  | '1w';

export const TIMEFRAMES: { value: Timeframe; label: string; ms: number }[] = [
  { value: '1m', label: '1m', ms: 60 * 1000 },
  { value: '5m', label: '5m', ms: 5 * 60 * 1000 },
  { value: '15m', label: '15m', ms: 15 * 60 * 1000 },
  { value: '30m', label: '30m', ms: 30 * 60 * 1000 },
  { value: '1h', label: '1h', ms: 60 * 60 * 1000 },
  { value: '4h', label: '4h', ms: 4 * 60 * 60 * 1000 },
  { value: '1d', label: '1D', ms: 24 * 60 * 60 * 1000 },
  { value: '1w', label: '1W', ms: 7 * 24 * 60 * 60 * 1000 },
];

export type IndicatorType = 'RSI' | 'MACD' | 'BBANDS' | 'SMA' | 'EMA';

export type MACDMode = 'signal_cross' | 'zero_cross' | 'histogram_sign';
export type BBandsMode = 'mean_reversion' | 'breakout';
export type MAMode = 'price_cross' | 'price_cross_trend';

/**
 * Domain-specific parameters for each indicator type. Only the fields that
 * apply to the indicator's `type` are meaningful — unrelated fields are
 * ignored. The settings UI exposes a different subset per type.
 */
export interface IndicatorParams {
  // Generic library params
  period?: number;
  fastPeriod?: number;
  slowPeriod?: number;
  signalPeriod?: number;
  stdDev?: number;

  // RSI-specific trading rule
  oversold?: number;
  overbought?: number;

  // MACD-specific trading rule
  macdMode?: MACDMode;

  // Bollinger-specific trading rule
  bbandsMode?: BBandsMode;

  // SMA / EMA trading rule
  maMode?: MAMode;
  /**
   * For maMode === 'price_cross_trend': how many candles back to compare
   * the MA's slope. Default 5.
   */
  trendLookback?: number;
}

export interface IndicatorConfig {
  id: string;
  type: IndicatorType;
  enabled: boolean;
  params: IndicatorParams;
  /**
   * Timeframe used when running the indicator's *standalone* performance
   * backtest (D/W/M/Y returns shown on its card). Independent from the
   * chart's currently-selected timeframe. Defaults to '4h'.
   */
  timeframe: Timeframe;
  color: string;
}

export interface IndicatorValues {
  rsi: number[] | null;
  macd: { MACD: number[]; signal: number[]; histogram: number[] } | null;
  bbands: { upper: number[]; middle: number[]; lower: number[] } | null;
  sma: { period: number; values: number[] }[];
  ema: { period: number; values: number[] }[];
}

export type AlertOperator = '>' | '<' | 'crosses_above' | 'crosses_below';
export type AlertIndicator = 'PRICE' | 'RSI' | 'MACD' | 'VOLUME';

export interface Alert {
  id: number;
  symbol: string;
  indicator: AlertIndicator;
  operator: AlertOperator;
  value: number;
  message: string;
  enabled: boolean;
  lastTriggered: string | null;
  createdAt: string;
}

export type ConditionOperator =
  | '>'
  | '<'
  | '>='
  | '<='
  | '=='
  | 'crosses_above'
  | 'crosses_below';

export type IndicatorParamKey =
  | 'macd'
  | 'signal'
  | 'histogram'
  | 'upper'
  | 'middle'
  | 'lower';

export interface StrategyCondition {
  id: string;
  indicator: IndicatorType | 'PRICE';
  /** When LHS is an indicator with multiple series, which series to read. */
  param?: IndicatorParamKey;
  operator: ConditionOperator;
  value: number | string;
  valueType: 'number' | 'indicator';
  /**
   * When `valueType === 'indicator'` and the RHS indicator has multiple
   * series (e.g. MACD has 'macd', 'signal', 'histogram'), which series to
   * read on the right-hand side. Falls back to `param` for back-compat.
   */
  valueParam?: IndicatorParamKey;
}

export interface Strategy {
  id?: number;
  name: string;
  description?: string;
  indicators: IndicatorConfig[];
  buyConditions: StrategyCondition[];
  sellConditions: StrategyCondition[];
  logic: 'AND' | 'OR';
}

export interface Trade {
  type: 'BUY' | 'SELL';
  time: number;
  price: number;
  quantity: number;
  pnl?: number;
  pnlPercent?: number;
}

export interface BacktestPerformance {
  initialCapital: number;
  finalCapital: number;
  totalReturn: number;
  totalReturnPercent: number;
  winRate: number;
  numberOfTrades: number;
  winningTrades: number;
  losingTrades: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: Timeframe;
  startTime: number;
  endTime: number;
  trades: Trade[];
  performance: BacktestPerformance;
  equity: { time: number; value: number }[];
}

/**
 * Trading direction modes.
 *   - `long-only`: classic spot-style backtest. BUY opens long, SELL closes it
 *     (going to cash). Cannot profit from falling prices.
 *   - `long-short`: stop-and-reverse. Always either long or short — SELL
 *     closes any long *and* opens a short of the same notional, BUY closes
 *     the short and goes long. Profits on both sides of the market.
 */
export type BacktestDirection = 'long-only' | 'long-short';

export interface BacktestSettings {
  symbol: string;
  timeframe: Timeframe;
  startTime: number;
  endTime: number;
  initialCapital: number;
  commission: number;
  /** Defaults to 'long-only' for backwards compatibility. */
  direction?: BacktestDirection;
}

/**
 * A single buy/sell point produced by an indicator's rules. Lightweight
 * version of `Trade` — no quantity or PnL because there's no portfolio being
 * simulated; just the moment the strategy condition flipped.
 */
export interface ChartSignal {
  time: number;
  type: 'BUY' | 'SELL';
  /**
   * The indicator that produced this signal (e.g. 'RSI', 'MACD'). When
   * multiple indicators emit a signal at the same time/type we collect their
   * labels for display in a single marker.
   */
  source: IndicatorType;
}

/**
 * Per-candle position state produced from a sequence of buy/sell signals.
 * Used to paint translucent green ("long") and red ("flat") background
 * bands behind the candles in focused-indicator mode.
 */
export type PositionState = 'long' | 'flat';
export interface CandlePosition {
  time: number;
  state: PositionState;
}
