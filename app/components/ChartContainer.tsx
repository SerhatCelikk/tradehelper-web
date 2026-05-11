'use client';

import { useAppStore } from '../store/store';
import Chart from './Chart';
import type { IndicatorValues } from '../lib/types';

interface Props {
  indicatorValues: IndicatorValues;
}

export default function ChartContainer({ indicatorValues }: Props) {
  const candleData = useAppStore((s) => s.candleData);
  const indicators = useAppStore((s) => s.indicators);
  const lastBacktest = useAppStore((s) => s.lastBacktest);
  const isLoadingHistory = useAppStore((s) => s.isLoadingHistory);
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const timeframe = useAppStore((s) => s.timeframe);

  if (isLoadingHistory && candleData.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-foreground-muted">
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full bg-accent animate-pulse" />
          Loading market data…
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <Chart
        data={candleData}
        indicators={indicators}
        indicatorValues={indicatorValues}
        trades={lastBacktest?.trades}
        datasetKey={`${selectedSymbol}|${timeframe}`}
      />
    </div>
  );
}
