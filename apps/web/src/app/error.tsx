"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console so dev tools + any error-tracking integrations pick it up
    console.error("[app/error]", error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="rounded-lg border border-[var(--hl-red)]/40 bg-[var(--hl-red)]/5 p-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[24px]">⚠️</span>
            <h1 className="text-[16px] font-semibold text-[var(--hl-red)]">Something went wrong</h1>
          </div>
          <p className="text-[12px] text-[var(--foreground)] mb-3 leading-relaxed">
            An error occurred while loading this page. You can try again, or go back to the main terminal.
          </p>
          {error.digest && (
            <div className="text-[9px] text-[var(--hl-muted)] font-mono mb-3">
              Error ID: {error.digest}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={reset}
              className="flex-1 py-2 rounded text-[12px] text-[var(--foreground)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] border border-[var(--hl-border)]"
            >
              Try again
            </button>
            <Link
              href="/"
              className="flex-1 py-2 rounded text-[12px] text-center font-medium bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110"
            >
              Back to terminal
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
