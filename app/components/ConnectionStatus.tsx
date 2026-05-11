'use client';

import { useAppStore } from '../store/store';
import { Wifi, WifiOff, AlertCircle } from './icons';

export default function ConnectionStatus() {
  const isStreamConnected = useAppStore((s) => s.isStreamConnected);
  const streamError = useAppStore((s) => s.streamError);
  const isLoadingHistory = useAppStore((s) => s.isLoadingHistory);

  if (isStreamConnected && !streamError && !isLoadingHistory) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 animate-fade-in">
      <div
        className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm shadow-lg backdrop-blur ${
          streamError
            ? 'bg-danger/10 border-danger/40 text-danger'
            : isLoadingHistory
              ? 'bg-accent/10 border-accent/40 text-accent'
              : 'bg-background-tertiary border-border text-foreground-muted'
        }`}
      >
        {streamError ? (
          <>
            <AlertCircle size={14} />
            <span>{streamError}</span>
          </>
        ) : isLoadingHistory ? (
          <>
            <span className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse" />
            Loading historical data…
          </>
        ) : !isStreamConnected ? (
          <>
            <WifiOff size={14} />
            Reconnecting…
          </>
        ) : (
          <>
            <Wifi size={14} />
            Connected
          </>
        )}
      </div>
    </div>
  );
}
