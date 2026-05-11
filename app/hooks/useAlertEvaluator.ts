'use client';

import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useAppStore } from '../store/store';
import { database } from '../lib/database';
import {
  describeAlert,
  evaluateAlerts,
  showNotification,
  type AlertEvalContext,
} from '../lib/notifications';
import type { IndicatorValues } from '../lib/types';

const MIN_INTERVAL_MS = 30_000;

/**
 * Watches the active candle stream + indicator values and triggers alerts.
 * Uses a 30-second debounce per evaluation cycle so we don't spam.
 */
export function useAlertEvaluator(indicatorValues: IndicatorValues) {
  const candleData = useAppStore((s) => s.candleData);
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const alerts = useAppStore((s) => s.alerts);
  const isDatabaseReady = useAppStore((s) => s.isDatabaseReady);
  const incrementUnread = useAppStore((s) => s.incrementUnread);
  const updateAlertLocal = useAppStore((s) => s.updateAlertLocal);

  const lastRunRef = useRef<number>(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!isDatabaseReady) return;
    if (!candleData || candleData.length < 2) return;
    if (alerts.length === 0) return;

    const now = Date.now();
    if (now - lastRunRef.current < MIN_INTERVAL_MS) return;
    if (inFlightRef.current) return;
    lastRunRef.current = now;
    inFlightRef.current = true;

    const lastIdx = candleData.length - 1;
    const last = candleData[lastIdx];
    const prev = candleData[lastIdx - 1];

    const ctx: AlertEvalContext = {
      symbol: selectedSymbol,
      price: last.close,
      prevPrice: prev?.close,
      volume: last.volume,
      prevVolume: prev?.volume,
    };

    if (indicatorValues.rsi && indicatorValues.rsi.length >= 2) {
      ctx.rsi = indicatorValues.rsi[indicatorValues.rsi.length - 1];
      ctx.prevRsi = indicatorValues.rsi[indicatorValues.rsi.length - 2];
    }
    if (
      indicatorValues.macd &&
      indicatorValues.macd.MACD.length >= 2 &&
      indicatorValues.macd.signal.length >= 2
    ) {
      const macdLine = indicatorValues.macd.MACD;
      const signalLine = indicatorValues.macd.signal;
      // For alert purposes, MACD operand = (MACD - signal); cross-zero is a cross.
      const i = macdLine.length - 1;
      ctx.macd = macdLine[i] - signalLine[i];
      ctx.prevMacd = macdLine[i - 1] - signalLine[i - 1];
    }

    const triggered = evaluateAlerts(ctx, alerts);
    if (triggered.length === 0) {
      inFlightRef.current = false;
      return;
    }

    (async () => {
      for (const trig of triggered) {
        const text = trig.alert.message
          ? trig.alert.message
          : describeAlert(trig.alert);
        const valueStr = Number.isFinite(trig.currentValue)
          ? `(${trig.currentValue.toFixed(4)})`
          : '';
        toast(`${trig.alert.symbol}: ${text} ${valueStr}`, { icon: '🔔' });
        await showNotification({
          title: `${trig.alert.symbol} alert`,
          body: `${text} ${valueStr}`,
          tag: `alert-${trig.alert.id}`,
        });

        const ts = new Date().toISOString();
        try {
          await database.setAlertTriggered(trig.alert.id, ts);
        } catch (err) {
          console.warn('Failed to persist alert trigger:', err);
        }
        updateAlertLocal({ ...trig.alert, lastTriggered: ts });
        incrementUnread();
      }
      inFlightRef.current = false;
    })();
  }, [
    candleData,
    indicatorValues,
    alerts,
    selectedSymbol,
    isDatabaseReady,
    incrementUnread,
    updateAlertLocal,
  ]);
}
