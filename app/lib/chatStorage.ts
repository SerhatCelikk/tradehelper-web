export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Optional grounding metadata attached to assistant replies. */
  grounding?: {
    queries: string[];
    sources: Array<{ title: string; uri: string }>;
  } | null;
}

export interface ChatSession {
  id: string;
  /** Auto-generated from the first message; user can rename later. */
  name: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

const SESSIONS_KEY = 'th_chat_sessions';
const ACTIVE_KEY = 'th_chat_active_session';
const MAX_SESSIONS = 25;

export function loadSessions(): ChatSession[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is ChatSession =>
          s &&
          typeof s === 'object' &&
          typeof s.id === 'string' &&
          Array.isArray(s.messages),
      )
      .map((s) => ({
        id: s.id,
        name: s.name ?? 'Untitled chat',
        createdAt: s.createdAt ?? Date.now(),
        updatedAt: s.updatedAt ?? s.createdAt ?? Date.now(),
        messages: s.messages,
      }));
  } catch (err) {
    console.warn('loadSessions failed:', err);
    return [];
  }
}

export function saveSessions(sessions: ChatSession[]): void {
  if (typeof window === 'undefined') return;
  try {
    // Trim the oldest sessions if we drift past the cap so localStorage
    // doesn't grow without bound. Sessions are sorted by updatedAt desc.
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    const trimmed = sorted.slice(0, MAX_SESSIONS);
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('saveSessions failed:', err);
  }
}

export function loadActiveSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveSessionId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id === null) window.localStorage.removeItem(ACTIVE_KEY);
    else window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function makeSession(name?: string): ChatSession {
  const now = Date.now();
  return {
    id: `s${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name:
      name ??
      `Chat · ${new Date(now).toLocaleString('en-US', {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })}`,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/**
 * Derive a session title from its first user message. Helps users tell
 * "BTC news" apart from "RSI parameter tweaks" in the session list.
 */
export function deriveSessionTitle(messages: ChatMessage[]): string | null {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return null;
  const raw = first.content.trim().replace(/\s+/g, ' ');
  if (raw.length === 0) return null;
  return raw.length > 36 ? raw.slice(0, 33) + '…' : raw;
}
