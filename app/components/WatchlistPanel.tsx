'use client';

import { useEffect, useState } from 'react';
import { useAppStore, POPULAR_SYMBOLS } from '../store/store';
import { Plus, Trash, StarFilled } from './icons';
import { fetchTickerStats } from '../lib/binance';

interface Props {
  onSelect?: () => void;
}

interface Stat {
  symbol: string;
  price: number;
  change: number;
}

export default function WatchlistPanel({ onSelect }: Props) {
  const watchlist = useAppStore((s) => s.watchlist);
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useAppStore((s) => s.setSelectedSymbol);
  const addToWatchlist = useAppStore((s) => s.addToWatchlist);
  const removeFromWatchlist = useAppStore((s) => s.removeFromWatchlist);
  const [adding, setAdding] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [stats, setStats] = useState<Record<string, Stat>>({});

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (watchlist.length === 0) return;
      try {
        const arr = await fetchTickerStats(watchlist);
        if (cancelled) return;
        const map: Record<string, Stat> = {};
        for (const t of arr) {
          map[t.symbol] = {
            symbol: t.symbol,
            price: t.price,
            change: t.priceChangePercent,
          };
        }
        setStats(map);
      } catch (err) {
        console.error('Failed to load ticker stats:', err);
      }
    }

    load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [watchlist]);

  const candidates = POPULAR_SYMBOLS.filter(
    (s) =>
      !watchlist.includes(s) &&
      s.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h2 className="panel-header mb-0 flex items-center gap-2">
          <StarFilled size={14} className="text-warning" />
          Watchlist
        </h2>
        <button
          className="btn-ghost p-1"
          onClick={() => setAdding(!adding)}
          aria-label="Add coin"
        >
          <Plus size={16} />
        </button>
      </div>

      {adding && (
        <div className="border-b border-border p-3 space-y-2">
          <input
            className="input text-sm"
            placeholder="Search coin..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value.toUpperCase())}
          />
          <div className="max-h-40 overflow-y-auto space-y-1">
            {candidates.slice(0, 10).map((sym) => (
              <button
                key={sym}
                className="w-full text-left px-2 py-1 text-sm rounded hover:bg-background-tertiary"
                onClick={() => {
                  addToWatchlist(sym);
                  setSearchTerm('');
                  setAdding(false);
                }}
              >
                {sym}
              </button>
            ))}
            {searchTerm.length > 0 &&
              !candidates.includes(searchTerm) &&
              !watchlist.includes(searchTerm) && (
                <button
                  className="w-full text-left px-2 py-1 text-sm rounded hover:bg-background-tertiary text-foreground-muted"
                  onClick={() => {
                    addToWatchlist(searchTerm);
                    setSearchTerm('');
                    setAdding(false);
                  }}
                >
                  Add custom: {searchTerm}
                </button>
              )}
          </div>
        </div>
      )}

      <ul className="flex-1 overflow-y-auto">
        {watchlist.map((sym) => {
          const stat = stats[sym];
          const isSelected = sym === selectedSymbol;
          return (
            <li key={sym}>
              <button
                className={`w-full flex items-center justify-between px-4 py-3 border-b border-border/50 transition-colors text-left ${
                  isSelected
                    ? 'bg-accent/10 border-l-2 border-l-accent'
                    : 'hover:bg-background-tertiary'
                }`}
                onClick={() => {
                  setSelectedSymbol(sym);
                  onSelect?.();
                }}
              >
                <div>
                  <div className="font-medium text-sm">{sym}</div>
                  {stat && (
                    <div className="text-xs text-foreground-muted font-mono mt-0.5">
                      ${formatPrice(stat.price)}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
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
                  <span
                    role="button"
                    tabIndex={0}
                    className="opacity-0 hover:opacity-100 group-hover:opacity-100 p-1 -m-1 rounded text-foreground-subtle hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromWatchlist(sym);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        removeFromWatchlist(sym);
                      }
                    }}
                    aria-label={`Remove ${sym}`}
                  >
                    <Trash size={14} />
                  </span>
                </div>
              </button>
            </li>
          );
        })}
        {watchlist.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-foreground-muted">
            No coins yet. Click + to add.
          </li>
        )}
      </ul>
    </div>
  );
}

function formatPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}
