"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

export function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openConnectModal, mounted }) => {
        const connected = mounted && account && chain;
        return (
          <div
            {...(!mounted && {
              "aria-hidden": true,
              style: { opacity: 0, pointerEvents: "none" as const, userSelect: "none" as const },
            })}
          >
            {connected ? (
              <button
                onClick={openAccountModal}
                className="h-7 px-4 rounded-[10px] text-[11px] font-medium border border-[var(--hl-border)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] text-[var(--foreground)] transition-colors flex items-center gap-1.5"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--hl-accent)]" />
                {account.displayName}
              </button>
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
