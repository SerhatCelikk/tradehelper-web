'use client';

import { useMemo, useState } from 'react';
import {
  useAppStore,
  type MarketCategory,
  type SymbolStat,
} from '../store/store';
import { COMMODITY_NAMES, classifySymbol } from '../lib/marketData';
import {
  ChevronDown,
  ChevronRight,
  Loader,
  Search,
  Star,
  StarFilled,
} from './icons';

interface Props {
  onSelect?: () => void;
}

export default function WatchlistPanel({ onSelect }: Props) {
  const watchlist = useAppStore((s) => s.watchlist);
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useAppStore((s) => s.setSelectedSymbol);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const allSymbols = useAppStore((s) => s.allSymbols);
  const stockSymbols = useAppStore((s) => s.stockSymbols);
  const commoditySymbols = useAppStore((s) => s.commoditySymbols);
  const symbolStats = useAppStore((s) => s.symbolStats);
  const isSymbolsLoading = useAppStore((s) => s.isSymbolsLoading);
  const symbolsError = useAppStore((s) => s.symbolsError);
  const collapsedSections = useAppStore((s) => s.collapsedSections);
  const toggleSection = useAppStore((s) => s.toggleSection);

  const [search, setSearch] = useState('');

  const trimmedSearch = search.trim().toUpperCase();
  const favoriteSet = useMemo(() => new Set(watchlist), [watchlist]);

  const matchesSearch = (sym: string): boolean => {
    if (!trimmedSearch) return true;
    if (sym.includes(trimmedSearch)) return true;
    const name = COMMODITY_NAMES[sym];
    return Boolean(name && name.toUpperCase().includes(trimmedSearch));
  };

  const favoriteList = useMemo(
    () => watchlist.filter(matchesSearch),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [watchlist, trimmedSearch],
  );
  const cryptoList = useMemo(
    () => allSymbols.filter(matchesSearch),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSymbols, trimmedSearch],
  );
  const stockList = useMemo(
    () => stockSymbols.filter(matchesSearch),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stockSymbols, trimmedSearch],
  );
  const commodityList = useMemo(
    () => commoditySymbols.filter(matchesSearch),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commoditySymbols, trimmedSearch],
  );

  const handlePick = (sym: string) => {
    setSelectedSymbol(sym);
    onSelect?.();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h2 className="panel-header mb-0 flex items-center gap-2">
          <StarFilled size={14} className="text-warning" />
          Markets
        </h2>
        <span className="text-xs text-foreground-muted">
          {allSymbols.length + stockSymbols.length + commoditySymbols.length > 0
            ? `${allSymbols.length + stockSymbols.length + commoditySymbols.length} assets`
            : ''}
        </span>
      </div>

      <div className="border-b border-border p-3">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-subtle pointer-events-none"
          />
          <input
            className="input text-sm pl-8"
            placeholder="Search BTC, AAPL, Gold…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section
          id="favorites"
          title="Favorites"
          count={favoriteList.length}
          collapsed={collapsedSections.favorites}
          onToggle={() => toggleSection('favorites')}
          accent="text-warning"
        >
          {favoriteList.length === 0 ? (
            <EmptyHint>
              {trimmedSearch
                ? 'No favorites match your search.'
                : 'Star any asset below to add it here.'}
            </EmptyHint>
          ) : (
            <ul>
              {favoriteList.map((sym) => (
                <SymbolRow
                  key={sym}
                  symbol={sym}
                  stat={symbolStats[sym]}
                  isFavorite
                  isSelected={sym === selectedSymbol}
                  onSelect={() => handlePick(sym)}
                  onToggleFavorite={() => toggleFavorite(sym)}
                />
              ))}
            </ul>
          )}
        </Section>

        <Section
          id="crypto"
          title="Crypto"
          count={cryptoList.length}
          collapsed={collapsedSections.crypto}
          onToggle={() => toggleSection('crypto')}
        >
          {symbolsError ? (
            <EmptyHint tone="error">
              Couldn&apos;t load Binance symbols. {symbolsError}
            </EmptyHint>
          ) : isSymbolsLoading && allSymbols.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-foreground-muted">
              <Loader size={14} />
              Loading symbols…
            </div>
          ) : cryptoList.length === 0 ? (
            <EmptyHint>No coins match your search.</EmptyHint>
          ) : (
            <PaginatedList
              symbols={cryptoList}
              symbolStats={symbolStats}
              favoriteSet={favoriteSet}
              selectedSymbol={selectedSymbol}
              onSelect={handlePick}
              onToggleFavorite={toggleFavorite}
              hasSearch={trimmedSearch.length > 0}
            />
          )}
        </Section>

        <Section
          id="stocks"
          title="Stocks"
          count={stockList.length}
          collapsed={collapsedSections.stocks}
          onToggle={() => toggleSection('stocks')}
        >
          {stockList.length === 0 ? (
            <EmptyHint>
              {trimmedSearch
                ? 'No stocks match your search.'
                : 'Loading stocks…'}
            </EmptyHint>
          ) : (
            <PaginatedList
              symbols={stockList}
              symbolStats={symbolStats}
              favoriteSet={favoriteSet}
              selectedSymbol={selectedSymbol}
              onSelect={handlePick}
              onToggleFavorite={toggleFavorite}
              hasSearch={trimmedSearch.length > 0}
            />
          )}
        </Section>

        <Section
          id="commodities"
          title="Commodities"
          count={commodityList.length}
          collapsed={collapsedSections.commodities}
          onToggle={() => toggleSection('commodities')}
        >
          {commodityList.length === 0 ? (
            <EmptyHint>
              {trimmedSearch
                ? 'No commodities match your search.'
                : 'Loading commodities…'}
            </EmptyHint>
          ) : (
            <PaginatedList
              symbols={commodityList}
              symbolStats={symbolStats}
              favoriteSet={favoriteSet}
              selectedSymbol={selectedSymbol}
              onSelect={handlePick}
              onToggleFavorite={toggleFavorite}
              hasSearch={trimmedSearch.length > 0}
            />
          )}
        </Section>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Section                                   */
/* -------------------------------------------------------------------------- */

interface SectionProps {
  id: MarketCategory;
  title: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  accent?: string;
  children: React.ReactNode;
}

function Section({
  id,
  title,
  count,
  collapsed,
  onToggle,
  accent,
  children,
}: SectionProps) {
  return (
    <section className="border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-background-tertiary transition-colors"
        aria-expanded={!collapsed}
        aria-controls={`section-${id}`}
      >
        <div className="flex items-center gap-2">
          {collapsed ? (
            <ChevronRight size={14} className="text-foreground-muted" />
          ) : (
            <ChevronDown size={14} className="text-foreground-muted" />
          )}
          <span
            className={`text-xs uppercase tracking-wide font-semibold ${
              accent ?? 'text-foreground-muted'
            }`}
          >
            {title}
          </span>
          {typeof count === 'number' && (
            <span className="text-[10px] text-foreground-subtle font-mono">
              {count}
            </span>
          )}
        </div>
      </button>
      {!collapsed && <div id={`section-${id}`}>{children}</div>}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Paginated list                                */
/* -------------------------------------------------------------------------- */

const INITIAL_VISIBLE = 80;
const PAGE_STEP = 80;

interface PaginatedListProps {
  symbols: string[];
  symbolStats: Record<string, SymbolStat>;
  favoriteSet: Set<string>;
  selectedSymbol: string;
  onSelect: (sym: string) => void;
  onToggleFavorite: (sym: string) => void;
  hasSearch: boolean;
}

function PaginatedList({
  symbols,
  symbolStats,
  favoriteSet,
  selectedSymbol,
  onSelect,
  onToggleFavorite,
  hasSearch,
}: PaginatedListProps) {
  const [visible, setVisible] = useState(INITIAL_VISIBLE);

  // With an active search the result set is already narrow — render it all.
  // Likewise for small lists (stocks/commodities) pagination is not needed.
  const shown =
    hasSearch || symbols.length <= INITIAL_VISIBLE
      ? symbols
      : symbols.slice(0, visible);
  const hiddenCount = Math.max(0, symbols.length - shown.length);

  return (
    <>
      <ul>
        {shown.map((sym) => (
          <SymbolRow
            key={sym}
            symbol={sym}
            stat={symbolStats[sym]}
            isFavorite={favoriteSet.has(sym)}
            isSelected={sym === selectedSymbol}
            onSelect={() => onSelect(sym)}
            onToggleFavorite={() => onToggleFavorite(sym)}
          />
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="w-full px-4 py-2 text-xs text-foreground-muted hover:text-foreground hover:bg-background-tertiary border-t border-border/50"
          onClick={() => setVisible((v) => v + PAGE_STEP)}
        >
          Show {Math.min(PAGE_STEP, hiddenCount)} more · {hiddenCount} hidden
        </button>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Symbol row                                  */
/* -------------------------------------------------------------------------- */

interface SymbolRowProps {
  symbol: string;
  stat: SymbolStat | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}

function SymbolRow({
  symbol,
  stat,
  isFavorite,
  isSelected,
  onSelect,
  onToggleFavorite,
}: SymbolRowProps) {
  const display = displaySymbol(symbol);
  const subline = subSymbol(symbol);

  return (
    <li>
      <div
        className={`flex items-center justify-between px-4 py-2.5 border-b border-border/40 transition-colors ${
          isSelected
            ? 'bg-accent/10 border-l-2 border-l-accent'
            : 'hover:bg-background-tertiary'
        }`}
      >
        <button
          type="button"
          onClick={onSelect}
          className="flex-1 min-w-0 text-left"
        >
          <div className="font-medium text-sm truncate">{display}</div>
          <div className="text-xs text-foreground-muted font-mono mt-0.5 tabular-nums truncate">
            {subline ? `${subline} · ` : ''}
            {stat ? `$${formatPrice(stat.price)}` : '—'}
          </div>
        </button>

        <div className="flex items-center gap-2 ml-2">
          {stat && (
            <span
              className={`text-xs tabular-nums ${
                stat.change >= 0 ? 'text-success' : 'text-danger'
              }`}
            >
              {stat.change >= 0 ? '+' : ''}
              {stat.change.toFixed(2)}%
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            className={`p-1 -m-1 rounded transition-colors ${
              isFavorite
                ? 'text-warning hover:text-warning/80'
                : 'text-foreground-subtle hover:text-warning'
            }`}
            aria-label={
              isFavorite ? `Remove ${symbol} from favorites` : `Add ${symbol} to favorites`
            }
            aria-pressed={isFavorite}
          >
            {isFavorite ? <StarFilled size={14} /> : <Star size={14} />}
          </button>
        </div>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function EmptyHint({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'error';
}) {
  const cls = tone === 'error' ? 'text-danger' : 'text-foreground-muted';
  return <div className={`px-4 py-4 text-xs ${cls}`}>{children}</div>;
}

function displaySymbol(sym: string): string {
  if (COMMODITY_NAMES[sym]) return COMMODITY_NAMES[sym];
  if (sym.endsWith('USDT')) return `${sym.slice(0, -4)} / USDT`;
  return sym;
}

/** Secondary label shown under the primary name (e.g. raw ticker). */
function subSymbol(sym: string): string {
  if (COMMODITY_NAMES[sym]) return sym;
  return '';
}

function formatPrice(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}

// Re-export for callers that need it without re-importing from marketData
export { classifySymbol };
