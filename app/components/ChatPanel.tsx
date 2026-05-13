'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';
import { useAppStore } from '../store/store';
import { useChat, type ChatContext } from '../hooks/useChat';
import {
  loadOptimization,
  type SavedOptimization,
} from '../lib/optimizerStorage';
import {
  HORIZON_DAYS,
  type OptimizerHorizon,
} from '../lib/optimizer';
import { classifySymbol } from '../lib/marketData';
import AssistantAvatar from './AssistantAvatar';
import {
  MessageCircle,
  Minimize2,
  Plus,
  Send,
  Sparkles,
  Trash,
  X,
} from './icons';
import type { ChatMessage, ChatSession } from '../lib/chatStorage';

const HORIZONS: OptimizerHorizon[] = ['daily', 'weekly', 'monthly', 'yearly'];

export default function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [showSessions, setShowSessions] = useState(false);

  const symbol = useAppStore((s) => s.selectedSymbol);
  const timeframe = useAppStore((s) => s.timeframe);
  const indicators = useAppStore((s) => s.indicators);
  const customStrategy = useAppStore((s) => s.customStrategy);
  const allSymbols = useAppStore((s) => s.allSymbols);
  const stockSymbols = useAppStore((s) => s.stockSymbols);
  const commoditySymbols = useAppStore((s) => s.commoditySymbols);
  const lastPrice = useAppStore((s) => s.lastPrice);
  const priceChange24h = useAppStore((s) => s.priceChange24h);

  const {
    sessions,
    active,
    isStreaming,
    error,
    selectSession,
    createSession,
    deleteSession,
    send,
    clearError,
  } = useChat();

  // Build the structured context once per render — fast (a few field reads).
  // Reads optimizer hints synchronously from localStorage; that's fine since
  // it's only invoked when the user actually sends a message.
  const buildContext = useCallback((): ChatContext => {
    const cryptoUniverse = new Set(allSymbols);
    const assetClass = classifySymbol(symbol, cryptoUniverse);
    const optimizerHints: ChatContext['optimizerHints'] = [];
    if (typeof window !== 'undefined') {
      for (const h of HORIZONS) {
        const saved: SavedOptimization | null = loadOptimization(symbol, timeframe, h);
        if (!saved) continue;
        // Take the best of each indicator type so the assistant can suggest
        // "for monthly try MACD(...)" without us blasting it with every
        // candidate the optimizer touched.
        for (const r of Object.values(saved.bestPerType)) {
          if (!r) continue;
          optimizerHints.push({
            horizon: `${h} (${HORIZON_DAYS[h]}d)`,
            indicatorType: r.type,
            params: r.params as Record<string, unknown>,
            testReturn: r.outSample?.totalReturnPercent ?? 0,
            trades: r.outSample?.numberOfTrades ?? 0,
            winRate: r.outSample?.winRate ?? 0,
          });
        }
      }
    }

    return {
      symbol,
      timeframe,
      assetClass,
      lastPrice: lastPrice ?? undefined,
      priceChange24h: priceChange24h ?? undefined,
      indicators: indicators.map((ind) => ({
        type: ind.type,
        params: ind.params as Record<string, unknown>,
        timeframe: ind.timeframe,
        enabled: ind.enabled,
      })),
      customStrategy:
        customStrategy.indicators.length > 0
          ? {
              indicators: customStrategy.indicators.map((i) => ({
                type: i.type,
                timeframe: i.timeframe,
                params: i.params as Record<string, unknown>,
              })),
              logic: customStrategy.logic,
            }
          : undefined,
      optimizerHints: optimizerHints.length > 0 ? optimizerHints : undefined,
      knownSymbols: [...allSymbols.slice(0, 60), ...stockSymbols, ...commoditySymbols],
    };
  }, [
    allSymbols,
    commoditySymbols,
    customStrategy,
    indicators,
    lastPrice,
    priceChange24h,
    stockSymbols,
    symbol,
    timeframe,
  ]);

  /* ---- Tickers + @-mention autocomplete --------------------------------- */

  const allTickers = useMemo(
    () => [...allSymbols, ...stockSymbols, ...commoditySymbols],
    [allSymbols, stockSymbols, commoditySymbols],
  );

  const [draft, setDraft] = useState('');
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toUpperCase();
    if (q.length === 0) return allTickers.slice(0, 8);
    return allTickers.filter((t) => t.toUpperCase().includes(q)).slice(0, 8);
  }, [mention, allTickers]);

  // Reset highlighted index when the suggestion set changes so we don't
  // point past the end of a freshly-filtered list.
  useEffect(() => {
    setMentionIdx(0);
  }, [mention?.query]);

  const handleInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setDraft(value);
    const cursor = e.target.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    // Matches @TICKER fragments only at word boundaries — avoids triggering
    // inside email-like strings or after letters.
    const match = before.match(/(?:^|\s)@([A-Za-z0-9=.-]*)$/);
    if (match) {
      setMention({
        start: cursor - match[1].length - 1, // -1 for the @
        query: match[1],
      });
    } else {
      setMention(null);
    }
  };

  const insertTicker = useCallback(
    (ticker: string) => {
      if (!mention) return;
      const before = draft.slice(0, mention.start);
      const after = draft.slice(mention.start + mention.query.length + 1);
      const inserted = `${before}@${ticker} ${after}`;
      setDraft(inserted);
      setMention(null);
      // Restore focus + place cursor right after the inserted ticker.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        const pos = mention.start + ticker.length + 2;
        ta.setSelectionRange(pos, pos);
      });
    },
    [draft, mention],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx(
          (i) => (i - 1 + mentionMatches.length) % mentionMatches.length,
        );
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        insertTicker(mentionMatches[mentionIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft('');
    setMention(null);
    await send(text, buildContext());
  };

  /* ---- Scroll-to-bottom on new message ---------------------------------- */

  const messageListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active?.messages.length, isStreaming]);

  /* ---- Render ----------------------------------------------------------- */

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-[70] flex items-center gap-2 rounded-full bg-background-secondary border border-border shadow-lg pl-2 pr-4 py-2 hover:bg-background-tertiary transition-colors animate-fade-in"
        aria-label="Open trading assistant"
      >
        <AssistantAvatar size={32} pulse />
        <span className="text-xs font-semibold text-foreground">
          Trading Assistant
        </span>
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-[70] w-[380px] max-w-[calc(100vw-2rem)] h-[540px] max-h-[calc(100vh-2rem)] flex flex-col rounded-xl border border-border bg-background-secondary shadow-2xl overflow-hidden animate-slide-up"
      role="dialog"
      aria-label="Trading assistant"
    >
      {/* Header */}
      <header className="flex items-center gap-2 px-3 py-2 border-b border-border bg-gradient-to-r from-purple-500/10 via-blue-500/10 to-cyan-500/10 flex-shrink-0">
        <AssistantAvatar size={28} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold leading-tight">
            Trading Assistant
          </div>
          <div className="text-[10px] text-foreground-subtle leading-tight truncate">
            {active?.name ?? 'New conversation'} · {symbol} · {timeframe}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowSessions((v) => !v)}
          className="btn-ghost p-1.5 text-foreground-muted"
          title="Sessions"
          aria-label="Toggle sessions"
        >
          <MessageCircle size={14} />
        </button>
        <button
          type="button"
          onClick={createSession}
          className="btn-ghost p-1.5 text-foreground-muted"
          title="New chat"
          aria-label="Start a new chat"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="btn-ghost p-1.5 text-foreground-muted"
          title="Minimize"
          aria-label="Minimize chat"
        >
          <Minimize2 size={14} />
        </button>
      </header>

      {/* Sessions overlay */}
      {showSessions && (
        <SessionsList
          sessions={sessions}
          activeId={active?.id ?? null}
          onSelect={(id) => {
            selectSession(id);
            setShowSessions(false);
          }}
          onDelete={deleteSession}
          onClose={() => setShowSessions(false)}
        />
      )}

      {/* Messages */}
      <div
        ref={messageListRef}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-background"
      >
        {!active || active.messages.length === 0 ? (
          <EmptyState symbol={symbol} timeframe={timeframe} />
        ) : (
          active.messages.map((m, i) => (
            <MessageBubble key={`${active.id}-${i}`} message={m} />
          ))
        )}
        {isStreaming && (
          <div className="flex items-center gap-2 text-foreground-subtle text-xs px-1">
            <AssistantAvatar size={20} />
            <span className="inline-flex items-center gap-0.5">
              <span className="h-1.5 w-1.5 bg-current rounded-full animate-pulse" />
              <span
                className="h-1.5 w-1.5 bg-current rounded-full animate-pulse"
                style={{ animationDelay: '120ms' }}
              />
              <span
                className="h-1.5 w-1.5 bg-current rounded-full animate-pulse"
                style={{ animationDelay: '240ms' }}
              />
            </span>
            <span>thinking…</span>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-2 text-[11px] text-danger bg-danger/10 border-t border-danger/30 flex items-start justify-between gap-2 flex-shrink-0">
          <span className="leading-snug">{error}</span>
          <button
            className="btn-ghost p-0.5 text-foreground-muted"
            onClick={clearError}
            aria-label="Dismiss error"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* Input */}
      <div className="relative border-t border-border bg-background-secondary flex-shrink-0">
        {mention && mentionMatches.length > 0 && (
          <MentionList
            matches={mentionMatches}
            highlighted={mentionIdx}
            onPick={insertTicker}
            knownSet={new Set(allSymbols)}
          />
        )}
        <div className="flex items-end gap-2 p-2.5">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask about a coin… try @BTCUSDT or @AAPL"
            rows={1}
            className="input text-xs flex-1 resize-none min-h-[32px] max-h-32 py-1.5"
            disabled={isStreaming}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!draft.trim() || isStreaming}
            className="btn-primary p-1.5 flex-shrink-0 disabled:opacity-50"
            aria-label="Send"
          >
            <Send size={14} />
          </button>
        </div>
        <div className="px-2.5 pb-1 text-[9px] text-foreground-subtle flex items-center gap-1.5">
          <Sparkles size={9} />
          <span>
            Knows your symbol, indicators, and last optimizer run · powered by
            Gemini
          </span>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Sub-components                                */
/* -------------------------------------------------------------------------- */

function EmptyState({ symbol, timeframe }: { symbol: string; timeframe: string }) {
  return (
    <div className="text-foreground-subtle text-xs space-y-2 p-2">
      <div className="flex items-start gap-2">
        <AssistantAvatar size={24} />
        <div className="leading-relaxed">
          <span className="text-foreground">Hi! I&apos;m your trading assistant.</span>
          <br />I know you&apos;re looking at{' '}
          <span className="font-mono text-foreground">{symbol}</span> on{' '}
          <span className="font-mono text-foreground">{timeframe}</span>.
        </div>
      </div>
      <div className="text-[11px] text-foreground-muted leading-relaxed bg-background-tertiary/60 border border-border/60 rounded p-2">
        Try asking:
        <ul className="mt-1 space-y-0.5 pl-3 list-disc">
          <li>
            <em>&quot;What&apos;s moving @BTCUSDT today?&quot;</em>
          </li>
          <li>
            <em>&quot;Which indicator setup did the optimizer like?&quot;</em>
          </li>
          <li>
            <em>&quot;Compare @AAPL and @GOOGL fundamentals.&quot;</em>
          </li>
        </ul>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      {!isUser && <AssistantAvatar size={22} className="mt-0.5 flex-shrink-0" />}
      <div className="min-w-0 max-w-[85%]">
        <div
          className={`rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${
            isUser
              ? 'bg-accent text-white rounded-tr-sm'
              : 'bg-background-tertiary text-foreground rounded-tl-sm'
          }`}
        >
          {renderInline(message.content)}
        </div>
        {!isUser && message.grounding?.sources && message.grounding.sources.length > 0 && (
          <div className="mt-1.5 text-[9px] text-foreground-subtle">
            <div className="uppercase tracking-wide mb-0.5">Sources</div>
            <ul className="space-y-0.5">
              {message.grounding.sources.slice(0, 5).map((src, idx) => (
                <li key={idx} className="truncate">
                  <a
                    href={src.uri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                    title={src.uri}
                  >
                    {src.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function MentionList({
  matches,
  highlighted,
  onPick,
  knownSet,
}: {
  matches: string[];
  highlighted: number;
  onPick: (ticker: string) => void;
  knownSet: Set<string>;
}) {
  return (
    <div className="absolute bottom-full left-2 right-2 mb-1 max-h-48 overflow-y-auto bg-background-secondary border border-border rounded shadow-lg">
      <ul className="py-1">
        {matches.map((ticker, idx) => (
          <li key={ticker}>
            <button
              type="button"
              onMouseDown={(e) => {
                // mousedown (not click) so the textarea doesn't lose focus
                // before the insertion happens.
                e.preventDefault();
                onPick(ticker);
              }}
              className={`w-full text-left px-2.5 py-1 text-xs flex items-center justify-between gap-2 ${
                idx === highlighted
                  ? 'bg-accent/15 text-foreground'
                  : 'text-foreground-muted hover:bg-background-tertiary'
              }`}
            >
              <span className="font-mono">{ticker}</span>
              <span className="text-[9px] uppercase text-foreground-subtle">
                {knownSet.has(ticker)
                  ? 'crypto'
                  : ticker.endsWith('=F')
                    ? 'commodity'
                    : 'stock'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SessionsList({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onClose,
}: {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute top-12 right-2 z-10 w-64 max-h-72 overflow-y-auto bg-background-secondary border border-border rounded-lg shadow-2xl animate-fade-in">
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border">
        <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          Conversations ({sessions.length})
        </span>
        <button
          className="btn-ghost p-0.5 text-foreground-subtle"
          onClick={onClose}
          aria-label="Close sessions"
        >
          <X size={12} />
        </button>
      </div>
      {sessions.length === 0 ? (
        <div className="px-3 py-4 text-[11px] text-foreground-subtle text-center">
          No conversations yet.
        </div>
      ) : (
        <ul>
          {sessions.map((s) => (
            <li
              key={s.id}
              className={`group flex items-center gap-2 px-2.5 py-1.5 border-b border-border/40 ${
                s.id === activeId
                  ? 'bg-accent/10 text-foreground'
                  : 'hover:bg-background-tertiary text-foreground-muted'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                className="flex-1 min-w-0 text-left"
              >
                <div className="text-xs truncate">{s.name}</div>
                <div className="text-[9px] text-foreground-subtle">
                  {new Date(s.updatedAt).toLocaleString('en-US', {
                    month: 'short',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  · {s.messages.length} msg
                </div>
              </button>
              <button
                type="button"
                onClick={() => onDelete(s.id)}
                className="btn-ghost p-1 text-foreground-subtle hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label={`Delete ${s.name}`}
              >
                <Trash size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Tiny markdown-ish render                        */
/* -------------------------------------------------------------------------- */

/** Renders **bold**, `code`, and bare URLs as anchors. Full markdown is
 *  overkill for short chat replies — and pulling in a parser bloats the
 *  bundle for an effectively-tiny feature. */
function renderInline(text: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  // Process line-by-line so paragraph breaks survive `whitespace-pre-wrap`.
  const lines = text.split('\n');
  lines.forEach((line, lineIdx) => {
    if (lineIdx > 0) out.push(<br key={`br-${lineIdx}`} />);
    const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/\S+)/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(line)) !== null) {
      if (match.index > cursor) {
        out.push(line.slice(cursor, match.index));
      }
      const tok = match[0];
      const key = `t-${lineIdx}-${match.index}`;
      if (tok.startsWith('**') && tok.endsWith('**')) {
        out.push(
          <strong key={key} className="font-semibold">
            {tok.slice(2, -2)}
          </strong>,
        );
      } else if (tok.startsWith('`') && tok.endsWith('`')) {
        out.push(
          <code
            key={key}
            className="font-mono text-[11px] bg-background-elevated px-1 py-0.5 rounded"
          >
            {tok.slice(1, -1)}
          </code>,
        );
      } else if (tok.startsWith('http')) {
        out.push(
          <a
            key={key}
            href={tok}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline break-all"
          >
            {tok}
          </a>,
        );
      }
      cursor = match.index + tok.length;
    }
    if (cursor < line.length) out.push(line.slice(cursor));
  });
  return out;
}
