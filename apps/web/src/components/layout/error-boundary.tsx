"use client";

import { Component, type ReactNode } from "react";

const API_URL = typeof window !== "undefined" && process.env.NODE_ENV === "production"
  ? "" : (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001");

export function reportClientError(error: Error, component: string, stack?: string | null) {
  try {
    fetch(`${API_URL}/api/market/client-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: stack || error.stack?.slice(0, 1000),
        component,
        url: typeof window !== "undefined" ? window.location.href : "",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      }),
    }).catch(() => {}); // fire and forget
  } catch {} // never let reporting itself crash
}

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[ErrorBoundary] Caught render error:", error, info.componentStack);
    reportClientError(error, "ErrorBoundary", info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[50vh] flex items-center justify-center">
          <div className="text-center space-y-4 max-w-md px-4">
            <h2 className="text-lg font-semibold text-[var(--foreground)]">Something went wrong</h2>
            <p className="text-sm text-[var(--hl-muted)]">
              {typeof this.state.error?.message === "string"
                ? this.state.error.message
                : "An unexpected error occurred"}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="px-4 py-2 text-sm bg-[var(--hl-accent)] text-[var(--background)] rounded hover:opacity-80 transition-opacity"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
