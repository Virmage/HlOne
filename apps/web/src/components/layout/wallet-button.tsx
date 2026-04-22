"use client";

import { useState, useRef, useEffect } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useDisconnect } from "wagmi";

/**
 * Wallet connect/disconnect button.
 *
 * Connected state: custom dropdown with Copy Address + Disconnect + a
 * "RainbowKit Modal" escape. The RainbowKit modal sometimes fails to open
 * on certain macOS/Safari configurations (CSP iframe restrictions, private
 * browsing, shields), which was leaving users unable to disconnect. The
 * dropdown works independently using wagmi's `useDisconnect` directly.
 */
export function WalletButton() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { disconnect } = useDisconnect();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openConnectModal, mounted }) => {
        const connected = mounted && account && chain;
        return (
          <div
            ref={rootRef}
            className="relative"
            {...(!mounted && {
              "aria-hidden": true,
              style: { opacity: 0, pointerEvents: "none" as const, userSelect: "none" as const },
            })}
          >
            {connected ? (
              <>
                <button
                  onClick={() => setOpen(o => !o)}
                  className="h-7 px-4 rounded-[10px] text-[11px] font-medium border border-[var(--hl-border)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] text-[var(--foreground)] transition-colors flex items-center gap-1.5"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--hl-accent)]" />
                  {account.displayName}
                  <svg width="8" height="5" viewBox="0 0 8 5" fill="none" className="ml-0.5">
                    <path d="M1 1L4 4L7 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {open && (
                  <div className="absolute right-0 top-[calc(100%+4px)] z-50 w-[200px] rounded-lg border border-[var(--hl-border)] bg-[var(--background)] shadow-2xl overflow-hidden">
                    <div className="px-3 py-2 border-b border-[var(--hl-border)] text-[10px] text-[var(--hl-muted)] uppercase tracking-wide">
                      {chain.name}
                    </div>
                    <button
                      onClick={() => {
                        navigator.clipboard?.writeText(account.address ?? "").catch(() => { /* ignore */ });
                        setOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 text-[11px] text-[var(--foreground)] hover:bg-[var(--hl-surface-hover)] transition-colors"
                    >
                      Copy address
                    </button>
                    <button
                      onClick={() => { setOpen(false); openAccountModal(); }}
                      className="w-full text-left px-3 py-2 text-[11px] text-[var(--foreground)] hover:bg-[var(--hl-surface-hover)] transition-colors"
                    >
                      Wallet details
                    </button>
                    <div className="border-t border-[var(--hl-border)]" />
                    <button
                      onClick={() => {
                        setOpen(false);
                        // Go through wagmi directly — doesn't depend on
                        // RainbowKit's modal which can fail on some configs.
                        disconnect();
                      }}
                      className="w-full text-left px-3 py-2 text-[11px] text-[var(--hl-red)] hover:bg-[var(--hl-surface-hover)] transition-colors font-medium"
                    >
                      Disconnect
                    </button>
                  </div>
                )}
              </>
            ) : (
              <button
                onClick={openConnectModal}
                className="h-7 px-4 rounded-[10px] text-[11px] font-semibold bg-[var(--hl-accent)] text-[var(--background)] hover:opacity-90 transition-opacity"
              >
                Connect
              </button>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
