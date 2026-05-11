'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI ErrorBoundary caught:', error, info);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex h-full w-full items-center justify-center p-8">
          <div className="max-w-md text-center space-y-3">
            <h2 className="text-lg font-semibold text-danger">
              Something went wrong
            </h2>
            <p className="text-sm text-foreground-muted">
              {this.state.error?.message ?? 'Unexpected error'}
            </p>
            <button className="btn-primary" onClick={this.reset}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
