'use client';

import { useEffect } from 'react';
import { hydrateStoreFromStorage, useAppStore } from '../store/store';
import { database } from '../lib/database';
import { registerServiceWorker } from '../lib/notifications';

export default function AppBootstrap() {
  const setDatabaseReady = useAppStore((s) => s.setDatabaseReady);
  const setAlerts = useAppStore((s) => s.setAlerts);
  const setStrategies = useAppStore((s) => s.setStrategies);
  const setNotificationPermission = useAppStore(
    (s) => s.setNotificationPermission,
  );

  useEffect(() => {
    hydrateStoreFromStorage();

    let cancelled = false;

    (async () => {
      try {
        await database.init();
        if (cancelled) return;
        const alerts = await database.getAlerts();
        const strategies = await database.getStrategies();
        setAlerts(alerts);
        setStrategies(strategies);
        setDatabaseReady(true);
      } catch (err) {
        console.error('Database init failed:', err);
      }
    })();

    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotificationPermission(
        (Notification.permission as NotificationPermission | 'default') ||
          'default',
      );
    }

    registerServiceWorker().catch((err) => {
      console.warn('SW register failed:', err);
    });

    return () => {
      cancelled = true;
    };
  }, [setAlerts, setStrategies, setDatabaseReady, setNotificationPermission]);

  return null;
}
