'use client';

import { detectCrossover } from './indicators';
import type { Alert, AlertOperator } from './types';

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined') return null;
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    });
    return reg;
  } catch (err) {
    console.warn('Service worker registration failed:', err);
    return null;
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined') return 'denied';
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return 'denied';
  }
}

export interface NotifyOpts {
  title: string;
  body: string;
  tag?: string;
  data?: unknown;
}

export async function showNotification(opts: NotifyOpts): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;

  // Prefer the SW registration so the notification persists when the tab loses focus.
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.showNotification(opts.title, {
          body: opts.body,
          icon: '/icon.svg',
          tag: opts.tag,
          data: opts.data,
        });
        return true;
      }
    } catch {
      /* fall through to direct Notification */
    }
  }
  try {
    new Notification(opts.title, {
      body: opts.body,
      icon: '/icon.svg',
      tag: opts.tag,
    });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                            Alert evaluation logic                          */
/* -------------------------------------------------------------------------- */

export interface AlertEvalContext {
  symbol: string;
  price: number;
  prevPrice?: number;
  rsi?: number;
  prevRsi?: number;
  macd?: number;
  prevMacd?: number;
  volume?: number;
  prevVolume?: number;
}

const COOLDOWN_MS = 5 * 60 * 1000;

export interface AlertTrigger {
  alert: Alert;
  currentValue: number;
}

export function evaluateAlerts(
  ctx: AlertEvalContext,
  alerts: Alert[],
): AlertTrigger[] {
  const triggered: AlertTrigger[] = [];
  const now = Date.now();

  for (const alert of alerts) {
    if (!alert.enabled) continue;
    if (alert.symbol.toUpperCase() !== ctx.symbol.toUpperCase()) continue;

    if (alert.lastTriggered) {
      const last = Date.parse(alert.lastTriggered);
      if (Number.isFinite(last) && now - last < COOLDOWN_MS) continue;
    }

    const reading = readForIndicator(alert, ctx);
    if (!reading) continue;
    const { current, previous } = reading;
    if (!Number.isFinite(current)) continue;

    if (
      checkOperator(alert.operator, current, previous, alert.value)
    ) {
      triggered.push({ alert, currentValue: current });
    }
  }

  return triggered;
}

function readForIndicator(
  alert: Alert,
  ctx: AlertEvalContext,
): { current: number; previous: number } | null {
  switch (alert.indicator) {
    case 'PRICE':
      return {
        current: ctx.price,
        previous: ctx.prevPrice ?? ctx.price,
      };
    case 'RSI':
      if (ctx.rsi === undefined) return null;
      return {
        current: ctx.rsi,
        previous: ctx.prevRsi ?? ctx.rsi,
      };
    case 'MACD':
      if (ctx.macd === undefined) return null;
      return {
        current: ctx.macd,
        previous: ctx.prevMacd ?? ctx.macd,
      };
    case 'VOLUME':
      if (ctx.volume === undefined) return null;
      return {
        current: ctx.volume,
        previous: ctx.prevVolume ?? ctx.volume,
      };
    default:
      return null;
  }
}

function checkOperator(
  op: AlertOperator,
  current: number,
  previous: number,
  threshold: number,
): boolean {
  switch (op) {
    case '>':
      return current > threshold;
    case '<':
      return current < threshold;
    case 'crosses_above':
      return detectCrossover(previous, current, threshold) === 'above';
    case 'crosses_below':
      return detectCrossover(previous, current, threshold) === 'below';
    default:
      return false;
  }
}

export function describeAlert(a: Alert): string {
  const op =
    a.operator === '>'
      ? '>'
      : a.operator === '<'
        ? '<'
        : a.operator === 'crosses_above'
          ? 'crosses above'
          : 'crosses below';
  return `${a.symbol} ${a.indicator} ${op} ${a.value}`;
}
