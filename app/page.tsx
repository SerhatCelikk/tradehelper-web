'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import Header from './components/Header';
import WatchlistPanel from './components/WatchlistPanel';
import IndicatorPerformancePanel from './components/IndicatorPerformancePanel';
import BacktestPanel from './components/BacktestPanel';
import AlertManager from './components/AlertManager';
import DatabaseManager from './components/DatabaseManager';
import { useAppStore } from './store/store';
import { useBinanceStream } from './hooks/useBinanceStream';
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
  const [showStrategyBuilder, setShowStrategyBuilder] = useState(false);
  const isMobileMenuOpen = useAppStore((s) => s.isMobileMenuOpen);
  const setMobileMenuOpen = useAppStore((s) => s.setMobileMenuOpen);

  // Wire up real-time stream + indicator computation + alert evaluation.
  useBinanceStream();
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

        {/* Center — chart on top, performance cards below */}
        <section className="flex flex-1 flex-col min-w-0 overflow-hidden">
          <div className="flex-shrink-0 h-[55vh] min-h-[360px] max-h-[640px]">
            <ChartContainer indicatorValues={indicatorValues} />
          </div>

          <div className="flex-1 min-h-0 border-t border-border bg-background-secondary">
            <IndicatorPerformancePanel />
          </div>
        </section>

        {/* Right — collapsible custom strategy builder */}
        <aside
          className={`hidden lg:flex flex-col border-l border-border bg-background-secondary transition-all flex-shrink-0 ${
            showStrategyBuilder ? 'w-80 xl:w-96' : 'w-12'
          }`}
        >
          <button
            className="border-b border-border px-3 py-2.5 text-xs uppercase tracking-wide text-foreground-muted hover:text-foreground hover:bg-background-tertiary text-left flex items-center justify-between gap-2"
            onClick={() => setShowStrategyBuilder(!showStrategyBuilder)}
            title={
              showStrategyBuilder
                ? 'Collapse strategy builder'
                : 'Open custom strategy builder'
            }
          >
            {showStrategyBuilder ? (
              <>
                <span>Custom Strategy</span>
                <span aria-hidden>›</span>
              </>
            ) : (
              <span
                className="block whitespace-nowrap"
                style={{
                  writingMode: 'vertical-rl',
                  transform: 'rotate(180deg)',
                }}
              >
                Custom Strategy
              </span>
            )}
          </button>

          {showStrategyBuilder && (
            <div className="flex-1 overflow-y-auto p-3">
              <BacktestPanel />
            </div>
          )}
        </aside>
      </main>

      <ConnectionStatus />

      {alertModalOpen && (
        <AlertManager onClose={() => setAlertModalOpen(false)} />
      )}
      {dbModalOpen && <DatabaseManager onClose={() => setDbModalOpen(false)} />}
    </div>
  );
}
