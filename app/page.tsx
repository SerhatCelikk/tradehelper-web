'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import Header from './components/Header';
import WatchlistPanel from './components/WatchlistPanel';
import IndicatorPerformancePanel from './components/IndicatorPerformancePanel';
import AlertManager from './components/AlertManager';
import DatabaseManager from './components/DatabaseManager';
import { useAppStore } from './store/store';
import { useMarketStream } from './hooks/useMarketStream';
import { useIndicators } from './hooks/useIndicators';
import { useAlertEvaluator } from './hooks/useAlertEvaluator';
import ConnectionStatus from './components/ConnectionStatus';

const ChartContainer = dynamic(() => import('./components/ChartContainer'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-background-secondary text-foreground-muted">
      Loading chart…
    </div>
  ),
});

export default function HomePage() {
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const [dbModalOpen, setDbModalOpen] = useState(false);
  const isMobileMenuOpen = useAppStore((s) => s.isMobileMenuOpen);
  const setMobileMenuOpen = useAppStore((s) => s.setMobileMenuOpen);

  // Wire up real-time stream + indicator computation + alert evaluation.
  useMarketStream();
  const indicatorValues = useIndicators();
  useAlertEvaluator(indicatorValues);

  return (
    <div className="flex min-h-screen flex-col">
      <Header
        onOpenAlerts={() => setAlertModalOpen(true)}
        onOpenSettings={() => setDbModalOpen(true)}
      />

      <main className="flex flex-1 overflow-hidden">
        {/* Left — watchlist */}
        <aside
          className={`${
            isMobileMenuOpen ? 'block' : 'hidden'
          } w-full border-r border-border bg-background-secondary lg:block lg:w-64 xl:w-72 flex-shrink-0`}
        >
          <WatchlistPanel onSelect={() => setMobileMenuOpen(false)} />
        </aside>

        {/* Center — chart on top, tabbed indicator + strategy panel below.
            The old right-side BacktestPanel was retired in favour of the
            "My Strategy" tab in IndicatorPerformancePanel, which uses each
            indicator's built-in buy/sell signal instead of asking the user
            to hand-roll raw conditions. */}
        <section className="flex flex-1 flex-col min-w-0 overflow-hidden">
          <div className="flex-shrink-0 h-[55vh] min-h-[360px] max-h-[640px]">
            <ChartContainer indicatorValues={indicatorValues} />
          </div>

          <div className="flex-1 min-h-0 border-t border-border bg-background-secondary">
            <IndicatorPerformancePanel />
          </div>
        </section>
      </main>

      <ConnectionStatus />

      {alertModalOpen && (
        <AlertManager onClose={() => setAlertModalOpen(false)} />
      )}
      {dbModalOpen && <DatabaseManager onClose={() => setDbModalOpen(false)} />}
    </div>
  );
}
