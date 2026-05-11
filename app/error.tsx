'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App route error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <h2 className="text-lg font-semibold text-danger">
          Something went wrong
        </h2>
        <p className="text-sm text-foreground-muted">
          {error.message || 'An unexpected error occurred.'}
        </p>
        <button className="btn-primary" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
