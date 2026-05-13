'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deriveSessionTitle,
  loadActiveSessionId,
  loadSessions,
  makeSession,
  saveActiveSessionId,
  saveSessions,
  type ChatMessage,
  type ChatSession,
} from '../lib/chatStorage';

/**
 * Conversation context the panel sends to /api/chat alongside the messages
 * so the assistant can reference what the user is actually looking at.
 */
export interface ChatContext {
  symbol?: string;
  timeframe?: string;
  assetClass?: 'crypto' | 'stock' | 'commodity';
  lastPrice?: number;
  priceChange24h?: number;
  indicators?: Array<{
    type: string;
    params: Record<string, unknown>;
    timeframe: string;
    enabled: boolean;
  }>;
  customStrategy?: {
    indicators: Array<{ type: string; timeframe: string; params: Record<string, unknown> }>;
    logic: 'AND' | 'OR';
  };
  optimizerHints?: Array<{
    horizon: string;
    indicatorType: string;
    params: Record<string, unknown>;
    testReturn: number;
    trades: number;
    winRate: number;
  }>;
  knownSymbols?: string[];
}

export interface UseChatReturn {
  sessions: ChatSession[];
  active: ChatSession | null;
  isStreaming: boolean;
  error: string | null;
  selectSession: (id: string) => void;
  createSession: () => void;
  deleteSession: (id: string) => void;
  send: (text: string, context: ChatContext) => Promise<void>;
  clearError: () => void;
}

/** Trim conversation history to the most recent N turns before sending to
 *  the model. Gemini Flash has plenty of room but past ~20 turns the older
 *  context is rarely load-bearing and the token bill grows unnecessarily. */
const HISTORY_WINDOW = 20;

export function useChat(): UseChatReturn {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // First-paint hydrate from localStorage.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const loaded = loadSessions();
    setSessions(loaded);
    const stored = loadActiveSessionId();
    if (stored && loaded.some((s) => s.id === stored)) {
      setActiveId(stored);
    } else if (loaded.length > 0) {
      setActiveId(loaded[0].id);
    }
  }, []);

  // Persist whenever sessions change after hydration. Skipping on the
  // pre-hydration empty render avoids stomping the saved data with `[]`.
  useEffect(() => {
    if (!hydratedRef.current) return;
    saveSessions(sessions);
  }, [sessions]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    saveActiveSessionId(activeId);
  }, [activeId]);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  const selectSession = useCallback((id: string) => {
    setActiveId(id);
    setError(null);
  }, []);

  const createSession = useCallback(() => {
    const session = makeSession();
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    setError(null);
  }, []);

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      // If we just deleted the active session, hop to the next-most-recent
      // one (or null if there's nothing left).
      setActiveId((current) => {
        if (current !== id) return current;
        return remaining[0]?.id ?? null;
      });
      return remaining;
    });
  }, []);

  const send = useCallback(
    async (text: string, context: ChatContext) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (isStreaming) return;

      // Ensure a session exists; create one on the fly if the user hits
      // Send before clicking "New chat".
      let targetSessionId = activeId;
      if (!targetSessionId) {
        const session = makeSession();
        setSessions((prev) => [session, ...prev]);
        setActiveId(session.id);
        targetSessionId = session.id;
      }

      const userMsg: ChatMessage = {
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      };

      // Optimistic append — user sees their own message immediately while
      // the API call is in flight.
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetSessionId) return s;
          const messages = [...s.messages, userMsg];
          return {
            ...s,
            messages,
            updatedAt: Date.now(),
            name:
              s.messages.length === 0
                ? deriveSessionTitle(messages) ?? s.name
                : s.name,
          };
        }),
      );

      setIsStreaming(true);
      setError(null);

      try {
        // Build history fresh from the latest sessions snapshot so we
        // don't miss the user message we just optimistically appended.
        const latest =
          (await new Promise<ChatSession | null>((resolve) => {
            setSessions((curr) => {
              const found = curr.find((s) => s.id === targetSessionId) ?? null;
              resolve(found);
              return curr;
            });
          })) ?? null;

        const historySource = latest ? latest.messages : [userMsg];
        const historyForApi = historySource
          .slice(-HISTORY_WINDOW)
          .map((m) => ({ role: m.role, content: m.content }));

        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: historyForApi, context }),
        });

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(
            (data as { error?: string }).error ?? `Server error ${resp.status}`,
          );
        }

        const data = (await resp.json()) as {
          reply?: string;
          grounding?: ChatMessage['grounding'];
        };
        const reply = (data.reply ?? '').trim() || '(empty response)';
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: reply,
          timestamp: Date.now(),
          grounding: data.grounding ?? null,
        };

        setSessions((prev) =>
          prev.map((s) =>
            s.id === targetSessionId
              ? {
                  ...s,
                  messages: [...s.messages, assistantMsg],
                  updatedAt: Date.now(),
                }
              : s,
          ),
        );
      } catch (err) {
        console.error('Chat send error:', err);
        setError(err instanceof Error ? err.message : 'Failed to send');
      } finally {
        setIsStreaming(false);
      }
    },
    [activeId, isStreaming],
  );

  return {
    sessions,
    active,
    isStreaming,
    error,
    selectSession,
    createSession,
    deleteSession,
    send,
    clearError: () => setError(null),
  };
}
