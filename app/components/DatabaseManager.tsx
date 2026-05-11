'use client';

import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useAppStore } from '../store/store';
import { database } from '../lib/database';
import { diagnoseEndpoints } from '../lib/binance';
import {
  Download,
  Upload,
  Trash,
  X,
  Settings,
  Wifi,
  Loader,
  Check,
  AlertCircle,
} from './icons';

interface Props {
  onClose: () => void;
}

interface DiagResult {
  endpoint: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export default function DatabaseManager({ onClose }: Props) {
  const isDatabaseReady = useAppStore((s) => s.isDatabaseReady);
  const setAlerts = useAppStore((s) => s.setAlerts);
  const setStrategies = useAppStore((s) => s.setStrategies);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [size, setSize] = useState<number>(0);
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagResults, setDiagResults] = useState<DiagResult[] | null>(null);

  const runDiagnostics = async () => {
    setDiagRunning(true);
    try {
      const r = await diagnoseEndpoints();
      setDiagResults(r);
    } catch (err) {
      console.error(err);
      toast.error('Diagnostics failed');
    } finally {
      setDiagRunning(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!isDatabaseReady) return;
    database.size().then(setSize).catch(() => setSize(0));
  }, [isDatabaseReady]);

  const exportDb = async () => {
    if (!isDatabaseReady) {
      toast.error('Database not ready');
      return;
    }
    try {
      const blob = await database.exportBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tradehelper-${new Date().toISOString().slice(0, 10)}.db`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Database exported');
    } catch (err) {
      console.error(err);
      toast.error('Export failed');
    }
  };

  const importDb = async (file: File) => {
    try {
      await database.importFromFile(file);
      const [alerts, strategies] = await Promise.all([
        database.getAlerts(),
        database.getStrategies(),
      ]);
      setAlerts(alerts);
      setStrategies(strategies);
      toast.success('Database imported');
      onClose();
    } catch (err) {
      console.error(err);
      toast.error('Import failed: ' + (err instanceof Error ? err.message : 'unknown'));
    }
  };

  const clearAll = async () => {
    if (
      !confirm(
        'Delete all alerts, strategies and backtest history? This cannot be undone.',
      )
    ) {
      return;
    }
    try {
      await database.clearAll();
      setAlerts([]);
      setStrategies([]);
      toast.success('All data cleared');
    } catch (err) {
      console.error(err);
      toast.error('Failed to clear data');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background-secondary p-5 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Settings size={18} /> Settings
          </h2>
          <button className="btn-ghost p-1" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <section className="space-y-4">
          <div>
            <h3 className="text-xs uppercase tracking-wide text-foreground-muted mb-2">
              Database
            </h3>
            <p className="text-xs text-foreground-subtle mb-3">
              Your data stays on this device. Export to back up or move it.
            </p>

            <div className="rounded-md bg-background-tertiary p-3 mb-3 flex items-center justify-between">
              <span className="text-sm text-foreground-muted">DB Size</span>
              <span className="font-mono text-sm">{formatBytes(size)}</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                className="btn-secondary flex items-center justify-center gap-2"
                onClick={exportDb}
                disabled={!isDatabaseReady}
              >
                <Download size={14} />
                Export
              </button>
              <button
                className="btn-secondary flex items-center justify-center gap-2"
                onClick={() => fileRef.current?.click()}
                disabled={!isDatabaseReady}
              >
                <Upload size={14} />
                Import
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".db,.sqlite,application/x-sqlite3"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importDb(f);
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-foreground-muted mb-2 flex items-center gap-2">
              <Wifi size={12} />
              Network diagnostics
            </h3>
            <p className="text-xs text-foreground-subtle mb-3">
              If price/indicator data fails to load, test which Binance
              mirrors your network can reach.
            </p>
            <button
              className="btn-secondary w-full flex items-center justify-center gap-2 mb-2"
              onClick={runDiagnostics}
              disabled={diagRunning}
            >
              {diagRunning ? (
                <>
                  <Loader size={14} />
                  Testing endpoints…
                </>
              ) : (
                <>
                  <Wifi size={14} />
                  Test Binance endpoints
                </>
              )}
            </button>
            {diagResults && (
              <ul className="text-xs space-y-1 mt-2 font-mono">
                {diagResults.map((r) => (
                  <li
                    key={r.endpoint}
                    className="flex items-center justify-between gap-2 rounded bg-background-tertiary px-2 py-1.5"
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      {r.ok ? (
                        <Check size={12} className="text-success flex-shrink-0" />
                      ) : (
                        <AlertCircle size={12} className="text-danger flex-shrink-0" />
                      )}
                      <span className="truncate">
                        {r.endpoint.replace(/^https?:\/\//, '')}
                      </span>
                    </span>
                    <span
                      className={`flex-shrink-0 ${
                        r.ok ? 'text-success' : 'text-danger'
                      }`}
                    >
                      {r.ok
                        ? `${r.latencyMs}ms`
                        : (r.error ?? 'fail').slice(0, 24)}
                    </span>
                  </li>
                ))}
                {diagResults.every((r) => !r.ok) && (
                  <li className="text-[11px] text-warning bg-warning/10 rounded px-2 py-2 mt-2 leading-relaxed">
                    All Binance endpoints unreachable from this network. Check
                    your firewall / ad-blocker / DNS, or enable a VPN. The data
                    mirror at <code>data-api.binance.vision</code> usually works
                    where the main API is blocked.
                  </li>
                )}
              </ul>
            )}
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-danger mb-2">
              Danger zone
            </h3>
            <button
              className="btn-secondary w-full flex items-center justify-center gap-2 text-danger border-danger/40 hover:bg-danger/10"
              onClick={clearAll}
              disabled={!isDatabaseReady}
            >
              <Trash size={14} />
              Clear all data
            </button>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-foreground-muted mb-2">
              About
            </h3>
            <div className="text-xs text-foreground-subtle space-y-1">
              <p>
                <span className="font-semibold text-foreground-muted">Data source:</span> Binance public WebSocket and REST API.
              </p>
              <p>
                <span className="font-semibold text-foreground-muted">Storage:</span> SQLite (sql.js) persisted in IndexedDB.
              </p>
              <p>
                <span className="font-semibold text-foreground-muted">Notifications:</span> Web Notification API + Service Worker.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}
