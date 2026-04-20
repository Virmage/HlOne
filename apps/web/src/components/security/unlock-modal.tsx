"use client";

/**
 * UnlockModal — shown when the user has password protection enabled but hasn't
 * entered their password yet in this browser session. Blocks trading actions
 * until they unlock.
 *
 * Mounted at app root (page.tsx). Renders nothing when security is disabled or
 * already unlocked.
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  isSecurityEnabled,
  getSessionPassword,
  setSessionPassword,
  verifySecurityPassword,
} from "@/lib/crypto-storage";
import { useSafeAccount } from "@/hooks/use-safe-account";
import { unlockSessionKey } from "@/lib/derive-exchange";
import { unlockAgent } from "@/lib/hl-exchange";

export function UnlockModal() {
  const { address } = useSafeAccount();
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Check on mount + any time the user's address changes
  useEffect(() => {
    const needsUnlock = isSecurityEnabled() && !getSessionPassword();
    setShow(needsUnlock);
  }, [address]);

  const unlock = async () => {
    setError("");
    setLoading(true);
    try {
      const ok = await verifySecurityPassword(password);
      if (!ok) {
        setError("Wrong password");
        setLoading(false);
        return;
      }
      // Store password in memory for this session
      setSessionPassword(password);

      // Pre-unlock all stored keys for this user so trading works immediately
      if (address) {
        await unlockSessionKey(address, password).catch(() => {});
        await unlockAgent(address, password).catch(() => {});
      }

      setShow(false);
      setPassword("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-[99990] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(6px)" }}
    >
      <div className="w-full max-w-[420px] bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-[var(--hl-accent)] via-[#f5a524] to-[var(--hl-accent)]" />
        <div className="p-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[16px]">🔒</span>
            <h2 className="text-[15px] font-semibold text-[var(--foreground)]">Unlock your keys</h2>
          </div>
          <p className="text-[11.5px] text-[var(--hl-muted)] leading-relaxed mb-4">
            Enter your HLOne password to decrypt your stored Derive session key and HL agent wallet. Needed once per browser session.
          </p>
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(""); }}
            onKeyDown={e => e.key === "Enter" && password && unlock()}
            placeholder="Password"
            autoFocus
            className="w-full px-3 py-2 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[13px] text-[var(--foreground)] outline-none focus:border-[var(--hl-accent)]"
          />
          {error && <div className="text-[11px] text-[var(--hl-red)] mt-2">{error}</div>}
          <button
            onClick={unlock}
            disabled={!password || loading}
            className="w-full mt-3 py-2.5 rounded text-[13px] font-semibold bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? "Unlocking..." : "Unlock"}
          </button>
          <div className="mt-3 pt-3 border-t border-[var(--hl-border)] text-center">
            <Link href="/security" className="text-[10px] text-[var(--hl-muted)] hover:text-[var(--foreground)]">
              Forgot password? Clear keys and re-import →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
