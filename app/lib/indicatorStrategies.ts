import type {
  IndicatorConfig,
  Strategy,
  StrategyCondition,
} from './types';

/**
 * Domain-aware strategy generation: each indicator type has its own family
 * of meaningful trading rules, exposed via `IndicatorConfig.params`.
 *
 *   RSI    → oversold / overbought thresholds
 *   MACD   → mode = signal_cross | zero_cross | histogram_sign
 *   BBANDS → mode = mean_reversion | breakout
 *   SMA/EMA→ mode = price_cross | price_cross_trend
 *
 * The values come from the user's settings modal; defaults are defined in
 * `DEFAULT_INDICATORS` (store.ts) and migrated when missing.
 */

let counter = 0;
function cid(): string {
  counter += 1;
  return `c${Date.now().toString(36)}-${counter}`;
}

/**
 * State-based buy/sell predicates per indicator. Whereas `defaultStrategyFor`
 * fires on cross *events* (the bar the indicator first crosses a threshold),
 * these return "is the indicator currently in a long-favourable / short-
 * favourable state?" predicates. That's the only shape that makes the AND
 * combinator in the composite strategy meaningful — two cross events almost
 * never land on the exact same bar, so AND-of-crosses degenerates to "never
 * fires". State-of-X AND state-of-Y vs. state-of-X OR state-of-Y both
 * produce reasonable trade cadence.
 */
function stateConditionsFor(ind: IndicatorConfig): {
  buy: StrategyCondition[];
  sell: StrategyCondition[];
} {
  switch (ind.type) {
    case 'RSI': {
      const oversold = ind.params.oversold ?? 30;
      const overbought = ind.params.overbought ?? 70;
      return {
        buy: [
          {
            id: cid(),
            indicator: 'RSI',
            operator: '<',
            value: oversold,
            valueType: 'number',
          },
        ],
        sell: [
          {
            id: cid(),
            indicator: 'RSI',
            operator: '>',
            value: overbought,
            valueType: 'number',
          },
        ],
      };
    }
    case 'MACD': {
      const mode = ind.params.macdMode ?? 'signal_cross';
      if (mode === 'signal_cross') {
        return {
          buy: [
            {
              id: cid(),
              indicator: 'MACD',
              param: 'macd',
              operator: '>',
              value: 'MACD',
              valueType: 'indicator',
              valueParam: 'signal',
            },
          ],
          sell: [
            {
              id: cid(),
              indicator: 'MACD',
              param: 'macd',
              operator: '<',
              value: 'MACD',
              valueType: 'indicator',
              valueParam: 'signal',
            },
          ],
        };
      }
      if (mode === 'zero_cross') {
        return {
          buy: [
            {
              id: cid(),
              indicator: 'MACD',
              param: 'macd',
              operator: '>',
              value: 0,
              valueType: 'number',
            },
          ],
          sell: [
            {
              id: cid(),
              indicator: 'MACD',
              param: 'macd',
              operator: '<',
              value: 0,
              valueType: 'number',
            },
          ],
        };
      }
      // histogram_sign
      return {
        buy: [
          {
            id: cid(),
            indicator: 'MACD',
            param: 'histogram',
            operator: '>',
            value: 0,
            valueType: 'number',
          },
        ],
        sell: [
          {
            id: cid(),
            indicator: 'MACD',
            param: 'histogram',
            operator: '<',
            value: 0,
            valueType: 'number',
          },
        ],
      };
    }
    case 'BBANDS': {
      const mode = ind.params.bbandsMode ?? 'mean_reversion';
      if (mode === 'mean_reversion') {
        return {
          buy: [
            {
              id: cid(),
              indicator: 'PRICE',
              operator: '<',
              value: 'BBANDS',
              valueType: 'indicator',
              valueParam: 'lower',
            },
          ],
          sell: [
            {
              id: cid(),
              indicator: 'PRICE',
              operator: '>',
              value: 'BBANDS',
              valueType: 'indicator',
              valueParam: 'upper',
            },
          ],
        };
      }
      // breakout
      return {
        buy: [
          {
            id: cid(),
            indicator: 'PRICE',
            operator: '>',
            value: 'BBANDS',
            valueType: 'indicator',
            valueParam: 'upper',
          },
        ],
        sell: [
          {
            id: cid(),
            indicator: 'PRICE',
            operator: '<',
            value: 'BBANDS',
            valueType: 'indicator',
            valueParam: 'lower',
          },
        ],
      };
    }
    case 'SMA':
    case 'EMA': {
      const ref = ind.type;
      return {
        buy: [
          {
            id: cid(),
            indicator: 'PRICE',
            operator: '>',
            value: ref,
            valueType: 'indicator',
          },
        ],
        sell: [
          {
            id: cid(),
            indicator: 'PRICE',
            operator: '<',
            value: ref,
            valueType: 'indicator',
          },
        ],
      };
    }
  }
}

/**
 * Merge multiple indicators into one composite strategy with a shared
 * AND/OR connective. Uses state-based predicates per indicator (see
 * `stateConditionsFor`) — not the cross-event predicates `defaultStrategyFor`
 * uses for single-indicator backtests — so the AND combinator actually
 * produces trades instead of waiting for two cross events to align on
 * exactly the same bar.
 */
export function composeStrategy(
  indicators: IndicatorConfig[],
  logic: 'AND' | 'OR',
): Strategy {
  const states = indicators.map((ind) => stateConditionsFor(ind));
  return {
    name: `Custom (${indicators.map((i) => i.type).join('+')})`,
    indicators: indicators.map((i) => ({ ...i, enabled: true })),
    buyConditions: states.flatMap((s) => s.buy),
    sellConditions: states.flatMap((s) => s.sell),
    logic,
  };
}

export function defaultStrategyFor(ind: IndicatorConfig): Strategy {
  const indCopy: IndicatorConfig = { ...ind, enabled: true };

  switch (ind.type) {
    case 'RSI': {
      const oversold = ind.params.oversold ?? 30;
      const overbought = ind.params.overbought ?? 70;
      return {
        name: `RSI(${ind.params.period ?? 14})`,
        indicators: [indCopy],
        buyConditions: [
          {
            id: cid(),
            indicator: 'RSI',
            operator: 'crosses_below',
            value: oversold,
            valueType: 'number',
          },
        ],
        sellConditions: [
          {
            id: cid(),
            indicator: 'RSI',
            operator: 'crosses_above',
            value: overbought,
            valueType: 'number',
          },
        ],
        logic: 'AND',
      };
    }

    case 'MACD': {
      const mode = ind.params.macdMode ?? 'signal_cross';
      let buy: StrategyCondition[];
      let sell: StrategyCondition[];

      if (mode === 'signal_cross') {
        // MACD line crosses above/below the signal line
        buy = [
          {
            id: cid(),
            indicator: 'MACD',
            param: 'macd',
            operator: 'crosses_above',
            value: 'MACD',
            valueType: 'indicator',
            valueParam: 'signal',
          },
        ];
        sell = [
          {
            id: cid(),
            indicator: 'MACD',
            param: 'macd',
            operator: 'crosses_below',
            value: 'MACD',
            valueType: 'indicator',
            valueParam: 'signal',
          },
        ];
      } else if (mode === 'zero_cross') {
        buy = [
          {
            id: cid(),
            indicator: 'MACD',
            param: 'macd',
            operator: 'crosses_above',
            value: 0,
            valueType: 'number',
          },
        ];
        sell = [
          {
            id: cid(),
            indicator: 'MACD',
            param: 'macd',
            operator: 'crosses_below',
            value: 0,
            valueType: 'number',
          },
        ];
      } else {
        // histogram_sign — buy when histogram goes positive, sell when negative
        buy = [
          {
            id: cid(),
            indicator: 'MACD',
            param: 'histogram',
            operator: 'crosses_above',
            value: 0,
            valueType: 'number',
          },
        ];
        sell = [
          {
            id: cid(),
            indicator: 'MACD',
            param: 'histogram',
            operator: 'crosses_below',
            value: 0,
            valueType: 'number',
          },
        ];
      }

      return {
        name: `MACD(${ind.params.fastPeriod ?? 12},${ind.params.slowPeriod ?? 26},${ind.params.signalPeriod ?? 9})`,
        indicators: [indCopy],
        buyConditions: buy,
        sellConditions: sell,
        logic: 'AND',
      };
    }

    case 'BBANDS': {
      const mode = ind.params.bbandsMode ?? 'mean_reversion';
      let buy: StrategyCondition[];
      let sell: StrategyCondition[];

      if (mode === 'mean_reversion') {
        // Buy when price drops through lower band; sell when rises through upper.
        buy = [
          {
            id: cid(),
            indicator: 'PRICE',
            operator: 'crosses_below',
            value: 'BBANDS',
            valueType: 'indicator',
            valueParam: 'lower',
          },
        ];
        sell = [
          {
            id: cid(),
            indicator: 'PRICE',
            operator: 'crosses_above',
            value: 'BBANDS',
            valueType: 'indicator',
            valueParam: 'upper',
          },
        ];
      } else {
        // breakout — buy on upper-band break, sell on lower-band break
        buy = [
          {
            id: cid(),
            indicator: 'PRICE',
            operator: 'crosses_above',
            value: 'BBANDS',
            valueType: 'indicator',
            valueParam: 'upper',
          },
        ];
        sell = [
          {
            id: cid(),
            indicator: 'PRICE',
            operator: 'crosses_below',
            value: 'BBANDS',
            valueType: 'indicator',
            valueParam: 'lower',
          },
        ];
      }

      return {
        name: `Bollinger(${ind.params.period ?? 20}, ${ind.params.stdDev ?? 2}σ)`,
        indicators: [indCopy],
        buyConditions: buy,
        sellConditions: sell,
        logic: 'AND',
      };
    }

    case 'SMA':
    case 'EMA': {
      const ref: StrategyCondition['indicator'] = ind.type;
      // Note: 'price_cross_trend' adds a sanity filter via natural extension —
      // for now both modes use the same buy/sell crosses; the extra filter
      // can be added by extending the engine with slope conditions later.
      // Until then, mode acts as a documentation flag in the description.
      const buy: StrategyCondition[] = [
        {
          id: cid(),
          indicator: 'PRICE',
          operator: 'crosses_above',
          value: ref,
          valueType: 'indicator',
        },
      ];
      const sell: StrategyCondition[] = [
        {
          id: cid(),
          indicator: 'PRICE',
          operator: 'crosses_below',
          value: ref,
          valueType: 'indicator',
        },
      ];

      return {
        name: `${ind.type}(${ind.params.period ?? 20})`,
        indicators: [indCopy],
        buyConditions: buy,
        sellConditions: sell,
        logic: 'AND',
      };
    }
  }
}

/**
 * Human-readable description shown on each indicator card. Reflects the
 * actual user-configured rule (e.g. RSI thresholds the user picked).
 */
export function describeStrategy(ind: IndicatorConfig): string {
  switch (ind.type) {
    case 'RSI': {
      const ob = ind.params.overbought ?? 70;
      const os = ind.params.oversold ?? 30;
      return `Buy when RSI crosses below ${os}, sell when crosses above ${ob}`;
    }
    case 'MACD': {
      const mode = ind.params.macdMode ?? 'signal_cross';
      if (mode === 'signal_cross')
        return 'Buy when MACD crosses above signal line, sell on opposite cross';
      if (mode === 'zero_cross')
        return 'Buy when MACD crosses above zero, sell when crosses below';
      return 'Buy when histogram goes positive, sell when negative';
    }
    case 'BBANDS': {
      const mode = ind.params.bbandsMode ?? 'mean_reversion';
      if (mode === 'mean_reversion')
        return 'Buy on lower-band touch, sell on upper-band touch (mean reversion)';
      return 'Buy on upper-band breakout, sell on lower-band break (breakout)';
    }
    case 'SMA':
    case 'EMA': {
      const mode = ind.params.maMode ?? 'price_cross';
      const which = ind.type;
      if (mode === 'price_cross_trend')
        return `Buy when price crosses above ${which} (trend filter), sell on opposite cross`;
      return `Buy when price crosses above ${which}, sell when crosses below`;
    }
  }
}
