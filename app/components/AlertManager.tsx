'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useAppStore, POPULAR_SYMBOLS } from '../store/store';
import { database } from '../lib/database';
import {
  describeAlert,
  requestNotificationPermission,
} from '../lib/notifications';
import {
  Plus,
  Trash,
  Edit,
  X,
  Check,
  AlertCircle,
  Bell,
} from './icons';
import type {
  Alert,
  AlertIndicator,
  AlertOperator,
} from '../lib/types';

interface Props {
  onClose: () => void;
}

export default function AlertManager({ onClose }: Props) {
  const alerts = useAppStore((s) => s.alerts);
  const setAlerts = useAppStore((s) => s.setAlerts);
  const isDatabaseReady = useAppStore((s) => s.isDatabaseReady);
  const watchlist = useAppStore((s) => s.watchlist);
  const selectedSymbol = useAppStore((s) => s.selectedSymbol);
  const notificationPermission = useAppStore((s) => s.notificationPermission);
  const setNotificationPermission = useAppStore(
    (s) => s.setNotificationPermission,
  );
  const resetUnread = useAppStore((s) => s.resetUnread);

  const [editingAlert, setEditingAlert] = useState<Partial<Alert> | null>(null);

  useEffect(() => {
    resetUnread();
  }, [resetUnread]);

  const handleSave = async (a: Partial<Alert>) => {
    if (!isDatabaseReady) {
      toast.error('Database not ready yet.');
      return;
    }
    if (!a.symbol || !a.indicator || !a.operator || a.value === undefined) {
      toast.error('Please fill all fields.');
      return;
    }

    if (notificationPermission !== 'granted') {
      const perm = await requestNotificationPermission();
      setNotificationPermission(perm);
      if (perm !== 'granted') {
        toast('Browser notifications are not enabled — toasts only.', {
          icon: '⚠️',
        });
      }
    }

    try {
      if (a.id) {
        await database.updateAlert(a as Alert);
        toast.success('Alert updated');
      } else {
        await database.createAlert({
          symbol: a.symbol,
          indicator: a.indicator,
          operator: a.operator,
          value: a.value as number,
          message: a.message ?? '',
          enabled: a.enabled ?? true,
        });
        toast.success('Alert created');
      }
      const fresh = await database.getAlerts();
      setAlerts(fresh);
      setEditingAlert(null);
    } catch (err) {
      console.error(err);
      toast.error(
        err instanceof Error ? err.message : 'Failed to save alert',
      );
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await database.deleteAlert(id);
      const fresh = await database.getAlerts();
      setAlerts(fresh);
      toast.success('Alert deleted');
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete alert');
    }
  };

  const handleToggle = async (a: Alert) => {
    try {
      await database.updateAlert({ ...a, enabled: !a.enabled });
      const fresh = await database.getAlerts();
      setAlerts(fresh);
    } catch (err) {
      console.error(err);
    }
  };

  const enableNotifications = async () => {
    const perm = await requestNotificationPermission();
    setNotificationPermission(perm);
    if (perm === 'granted') {
      toast.success('Notifications enabled');
    } else {
      toast.error('Notifications denied');
    }
  };

  return (
    <Modal onClose={onClose} title="Alerts">
      {notificationPermission !== 'granted' && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} />
            <span>
              Browser notifications are not enabled. Alerts will only show as
              toasts.
            </span>
          </div>
          <button
            className="btn-secondary text-xs px-2 py-1"
            onClick={enableNotifications}
          >
            Enable
          </button>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">
          Active alerts ({alerts.filter((a) => a.enabled).length}/{alerts.length})
        </h3>
        <button
          className="btn-primary text-xs flex items-center gap-1"
          onClick={() =>
            setEditingAlert({
              symbol: selectedSymbol,
              indicator: 'PRICE',
              operator: '>',
              value: 0,
              message: '',
              enabled: true,
            })
          }
        >
          <Plus size={12} />
          New Alert
        </button>
      </div>

      <ul className="space-y-2 max-h-[60vh] overflow-y-auto">
        {alerts.length === 0 && (
          <li className="text-center py-8 text-foreground-muted text-sm">
            <Bell size={32} className="mx-auto mb-2 opacity-40" />
            No alerts yet. Click <strong>New Alert</strong> to add one.
          </li>
        )}
        {alerts.map((a) => (
          <li
            key={a.id}
            className="rounded-md border border-border bg-background-tertiary px-3 py-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-medium">
                    {describeAlert(a)}
                  </span>
                  {!a.enabled && (
                    <span className="badge bg-foreground-subtle/20 text-foreground-muted">
                      Disabled
                    </span>
                  )}
                  {a.lastTriggered && (
                    <span className="text-[10px] text-foreground-subtle">
                      last:{' '}
                      {new Date(a.lastTriggered).toLocaleString(undefined, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </span>
                  )}
                </div>
                {a.message && (
                  <p className="text-xs text-foreground-muted mt-0.5">
                    {a.message}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  className={`p-1 rounded ${
                    a.enabled
                      ? 'text-success hover:bg-success/10'
                      : 'text-foreground-subtle hover:bg-background-elevated'
                  }`}
                  onClick={() => handleToggle(a)}
                  title={a.enabled ? 'Disable' : 'Enable'}
                >
                  <Check size={14} />
                </button>
                <button
                  className="p-1 rounded text-foreground-muted hover:bg-background-elevated"
                  onClick={() => setEditingAlert(a)}
                  title="Edit"
                >
                  <Edit size={14} />
                </button>
                <button
                  className="p-1 rounded text-foreground-muted hover:bg-danger/10 hover:text-danger"
                  onClick={() => {
                    if (confirm(`Delete alert: ${describeAlert(a)}?`)) {
                      handleDelete(a.id);
                    }
                  }}
                  title="Delete"
                >
                  <Trash size={14} />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {editingAlert && (
        <AlertEditor
          alert={editingAlert}
          watchlist={watchlist}
          onSave={handleSave}
          onCancel={() => setEditingAlert(null)}
        />
      )}
    </Modal>
  );
}

function AlertEditor({
  alert,
  watchlist,
  onSave,
  onCancel,
}: {
  alert: Partial<Alert>;
  watchlist: string[];
  onSave: (a: Partial<Alert>) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Partial<Alert>>(alert);

  const symbols = Array.from(new Set([...watchlist, ...POPULAR_SYMBOLS]));

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background-secondary p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-semibold">
            {alert.id ? 'Edit alert' : 'New alert'}
          </h4>
          <button className="btn-ghost p-1" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="Symbol">
            <select
              className="select"
              value={draft.symbol ?? ''}
              onChange={(e) => setDraft({ ...draft, symbol: e.target.value })}
            >
              {symbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Indicator">
            <select
              className="select"
              value={draft.indicator ?? 'PRICE'}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  indicator: e.target.value as AlertIndicator,
                })
              }
            >
              <option value="PRICE">Price</option>
              <option value="RSI">RSI</option>
              <option value="MACD">MACD (line - signal)</option>
              <option value="VOLUME">Volume</option>
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Operator">
              <select
                className="select"
                value={draft.operator ?? '>'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    operator: e.target.value as AlertOperator,
                  })
                }
              >
                <option value=">">{'>'}</option>
                <option value="<">{'<'}</option>
                <option value="crosses_above">crosses above</option>
                <option value="crosses_below">crosses below</option>
              </select>
            </Field>
            <Field label="Value">
              <input
                type="number"
                step="0.0001"
                className="input"
                value={draft.value ?? 0}
                onChange={(e) =>
                  setDraft({ ...draft, value: Number(e.target.value) })
                }
              />
            </Field>
          </div>

          <Field label="Message (optional)">
            <input
              type="text"
              className="input"
              value={draft.message ?? ''}
              maxLength={120}
              placeholder="e.g. BTC oversold"
              onChange={(e) => setDraft({ ...draft, message: e.target.value })}
            />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox"
              checked={draft.enabled ?? true}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            Enabled
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(draft)}>
            {alert.id ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-foreground-subtle mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

function Modal({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-lg border border-border bg-background-secondary p-5 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            className="btn-ghost p-1"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
