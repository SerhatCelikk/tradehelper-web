'use client';

import { Menu, Bell, Settings, LineChart, X } from './icons';
import { useAppStore, POPULAR_SYMBOLS } from '../store/store';
import { formatPrice } from '../lib/marketData';
import { TIMEFRAMES, type Timeframe } from '../lib/types';

interface Props {
  onOpenAlerts: () => void;
  onOpenSettings: () => void;
}

export default function Header({ onOpenAlerts, onOpenSettings }: Props) {
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useAppStore((s) => s.setSelectedSymbol);
  const timeframe = useAppStore((s) => s.timeframe);
  const setTimeframe = useAppStore((s) => s.setTimeframe);
  const watchlist = useAppStore((s) => s.watchlist);
  const allSymbols = useAppStore((s) => s.allSymbols);
  const stockSymbols = useAppStore((s) => s.stockSymbols);
  const commoditySymbols = useAppStore((s) => s.commoditySymbols);
  const symbolPrecisions = useAppStore((s) => s.symbolPrecisions);
  const lastPrice = useAppStore((s) => s.lastPrice);
  const priceChange24h = useAppStore((s) => s.priceChange24h);
  const unreadNotifications = useAppStore((s) => s.unreadNotifications);
  const isMobileMenuOpen = useAppStore((s) => s.isMobileMenuOpen);
  const setMobileMenuOpen = useAppStore((s) => s.setMobileMenuOpen);
  const isStreamConnected = useAppStore((s) => s.isStreamConnected);

  // Favorites surface at the top of the dropdown; the full Binance universe
  // plus the curated Yahoo lists follow once they've loaded. Until then,
  // fall back to a curated popular crypto set so the selector is never empty
  // on cold start.
  const cryptoUniverse = allSymbols.length > 0 ? allSymbols : POPULAR_SYMBOLS;
  const universe = [...cryptoUniverse, ...stockSymbols, ...commoditySymbols];
  const favoriteEntries = watchlist.filter((s) => s !== selectedSymbol);
  const restEntries = universe.filter(
    (s) => s !== selectedSymbol && !watchlist.includes(s),
  );
  const symbols = Array.from(
    new Set([selectedSymbol, ...favoriteEntries, ...restEntries]),
  );

  return (
    <header className="flex items-center justify-between gap-3 border-b border-border bg-background-secondary px-4 py-3">
      {/* Left: logo + mobile menu */}
      <div className="flex items-center gap-3">
        <button
          className="btn-ghost p-1 lg:hidden"
          onClick={() => setMobileMenuOpen(!isMobileMenuOpen)}
          aria-label="Toggle menu"
        >
          {isMobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <div className="flex items-center gap-2">
          <LineChart size={20} className="text-accent" />
          <span className="font-bold text-lg hidden sm:block">TradeHelper</span>
        </div>
      </div>

      {/* Center: symbol selector + price */}
      <div className="flex items-center gap-2 sm:gap-4 flex-1 justify-center max-w-2xl">
        <select
          className="select max-w-[160px] font-medium"
          value={selectedSymbol}
          onChange={(e) => setSelectedSymbol(e.target.value)}
          aria-label="Select symbol"
        >
          {symbols.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <div className="hidden md:flex items-center gap-1 bg-background-tertiary rounded-md p-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              onClick={() => setTimeframe(tf.value as Timeframe)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                timeframe === tf.value
                  ? 'bg-accent text-white'
                  : 'text-foreground-muted hover:text-foreground'
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        {lastPrice !== null && (
          <div className="hidden sm:flex items-baseline gap-2">
            <span className="font-mono font-semibold tabular-nums">
              ${formatPrice(lastPrice, selectedSymbol, symbolPrecisions)}
            </span>
            {priceChange24h !== null && (
              <span
                className={`text-xs tabular-nums ${
                  priceChange24h >= 0 ? 'text-success' : 'text-danger'
                }`}
              >
                {priceChange24h >= 0 ? '+' : ''}
                {priceChange24h.toFixed(2)}%
              </span>
            )}
          </div>
        )}
      </div>

      {/* Mobile timeframe */}
      <div className="md:hidden flex items-center">
        <select
          className="select max-w-[80px] text-xs"
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value as Timeframe)}
          aria-label="Timeframe"
        >
          {TIMEFRAMES.map((tf) => (
            <option key={tf.value} value={tf.value}>
              {tf.label}
            </option>
          ))}
        </select>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-1 sm:gap-2">
        <span
          className={`hidden sm:inline-block h-2 w-2 rounded-full ${
            isStreamConnected
              ? 'bg-success animate-pulse-slow'
              : 'bg-foreground-subtle'
          }`}
          title={isStreamConnected ? 'Connected' : 'Disconnected'}
        />
        <button
          className="btn-ghost relative p-2"
          onClick={onOpenAlerts}
          aria-label="Alerts"
        >
          <Bell size={18} />
          {unreadNotifications > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
              {unreadNotifications > 9 ? '9+' : unreadNotifications}
            </span>
          )}
        </button>
        <button
          className="btn-ghost p-2"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}

