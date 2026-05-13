'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/store';
import {
  executeChatTool,
  toolStatusLabel,
  type ToolCall,
  type ToolExecutionContext,
} from '../lib/chatTools';
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
  availableOptimizerHorizons?: string[];
}

export interface UseChatReturn {
  sessions: ChatSession[];
  active: ChatSession | null;
  isStreaming: boolean;
  status: string | null;
  error: string | null;
  selectSession: (id: string) => void;
  createSession: () => void;
  deleteSession: (id: string) => void;
  send: (text: string, context: ChatContext) => Promise<void>;
  clearError: () => void;
}

/* -------------------------------------------------------------------------- */
/*                              Internal types                                */
/* -------------------------------------------------------------------------- */

/** In-flight message format used to talk to /api/chat. Mirrors the
 *  server's discriminated union — `assistant_tool` and `tool` entries are
 *  the model's function call + the client-executed result respectively. */
type APIMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | {
      role: 'assistant_tool';
      name: string;
      args: Record<string, unknown>;
      /** Round-tripped from the previous Gemini response — required by
       *  newer Gemini versions when a functionCall part appears in the
       *  history we send back. */
      thoughtSignature?: string;
    }
  | { role: 'tool'; name: string; response: unknown };

interface APIResponse {
  toolCall: {
    name: string;
    args: Record<string, unknown>;
    thoughtSignature?: string;
  } | null;
  reply: string;
  grounding: ChatMessage['grounding'];
  finishReason: string | null;
}

const HISTORY_WINDOW = 20;
// 4 rounds lets the model chain run-optimizer → apply-best-settings → wrap-up
// without bumping the cap mid-conversation. The optimizer round itself is
// ~15-30s, so we don't want chains to grow unboundedly either.
const MAX_TOOL_ROUNDS = 4;

/* -------------------------------------------------------------------------- */
/*                                   Hook                                     */
/* -------------------------------------------------------------------------- */

export function useChat(): UseChatReturn {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Store actions used by the tool executor.
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const timeframe = useAppStore((s) => s.timeframe);
  const replaceOrAddIndicator = useAppStore((s) => s.replaceOrAddIndicator);
  const allSymbols = useAppStore((s) => s.allSymbols);

  // Hydrate once.
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

      // Ensure a session exists.
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

      // Optimistic append so the user sees their message immediately.
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
      setStatus(null);

      const toolCtx: ToolExecutionContext = {
        symbol: selectedSymbol,
        timeframe,
        replaceOrAddIndicator,
        cryptoUniverse: new Set(allSymbols),
      };

      try {
        // Build the API message history: persisted user/assistant turns +
        // the new user message.
        const persisted = (active?.messages ?? []).slice(-HISTORY_WINDOW);
        const workingHistory: APIMessage[] = [
          ...persisted.map<APIMessage>((m) =>
            m.role === 'user'
              ? { role: 'user', content: m.content }
              : { role: 'assistant', content: m.content },
          ),
          { role: 'user', content: trimmed },
        ];

        let finalReply = '';
        let finalGrounding: ChatMessage['grounding'] = null;
        let round = 0;

        while (round < MAX_TOOL_ROUNDS) {
          round++;
          const resp = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: workingHistory, context }),
          });

          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(
              (errData as { error?: string }).error ??
                `Server error ${resp.status}`,
            );
          }

          const data = (await resp.json()) as APIResponse;

          if (data.toolCall) {
            // Surface "what I'm doing" while the tool runs — even though
            // the actual store mutation is synchronous, the model has yet
            // to compose its follow-up reply so the user sees a step.
            const call: ToolCall = {
              name: data.toolCall.name,
              args: data.toolCall.args ?? {},
            };
            setStatus(toolStatusLabel(call));
            const toolResult = await executeChatTool(call, toolCtx);
            workingHistory.push({
              role: 'assistant_tool',
              name: call.name,
              args: call.args,
              thoughtSignature: data.toolCall.thoughtSignature,
            });
            workingHistory.push({
              role: 'tool',
              name: call.name,
              response: toolResult,
            });
            continue;
          }

          finalReply = (data.reply ?? '').trim();
          finalGrounding = data.grounding ?? null;
          break;
        }

        setStatus(null);

        if (!finalReply) {
          finalReply =
            '(The assistant didn\'t produce a final text response after the tool call.)';
        }

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: finalReply,
          timestamp: Date.now(),
          grounding: finalGrounding,
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
        setStatus(null);
      }
    },
    [
      active,
      activeId,
      isStreaming,
      selectedSymbol,
      timeframe,
      replaceOrAddIndicator,
      allSymbols,
    ],
  );

  return {
    sessions,
    active,
    isStreaming,
    status,
    error,
    selectSession,
    createSession,
    deleteSession,
    send,
    clearError: () => setError(null),
  };
}
