"use client";

/**
 * OrderConfirmModal — shows exactly what's about to be signed before submitting.
 *
 * Threat: a compromised frontend could display one order in the UI but sign a
 * different one (e.g., show "Buy 1 BTC" but actually sign "Withdraw all to
 * attacker address"). This modal forces the user to review the actual values
 * that will be signed, catching discrepancies.
 *
 * Appears for trades above the user's confirmation threshold (default $500).
 * Can be configured via /security or skipped with a remember-for-session toggle.
 */

import { useState } from "react";

interface OrderDescription {
  title: string;
  direction: "Buy" | "Sell";
  asset: string;
  size: string;
  price: string;
  notionalUsd: string;
  type: string;
  details: Array<{ label: string; value: string; highlight?: boolean }>;
}

interface OrderConfirmModalProps {
  description: OrderDescription;
  warnings?: string[];
  onConfirm: () => void;
  onCancel: () => void;
  /** Builder fee that will be applied — displayed for transparency */
  builderInfo?: { address: string; feePercent: string };
}

export function OrderConfirmModal({
  description,
  warnings = [],
  onConfirm,
  onCancel,
  builderInfo,
}: OrderConfirmModalProps) {
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      setLoading(false);
    }
  };

  const dirColor = description.direction === "Buy" ? "var(--hl-green)" : "var(--hl-red)";

  return (
    <div
      className="fixed inset-0 z-[99990] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(6px)" }}
    >
      <div className="w-full max-w-[440px] bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl overflow-hidden">
        <div className="h-1" style={{ background: dirColor }} />
        <div className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[18px]">{description.direction === "Buy" ? "📈" : "📉"}</span>
            <h2 className="text-[15px] font-semibold text-[var(--foreground)]">Confirm order</h2>
          </div>

          <p className="text-[11px] text-[var(--hl-muted)] mb-4 leading-relaxed">
            Review the exact values being signed. These come from the data that will go on-chain — if they don't match what you clicked, <span className="text-[var(--hl-red)]">cancel immediately</span> and refresh the page.
          </p>

          {/* Order summary table */}
          <div className="rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] divide-y divide-[var(--hl-border)]">
            {description.details.map(d => (
              <div key={d.label} className="flex items-center justify-between px-3 py-2">
                <span className="text-[10.5px] text-[var(--hl-muted)] uppercase tracking-wide">{d.label}</span>
                <span
                  className={`text-[12px] font-mono ${d.highlight ? "font-semibold" : ""}`}
                  style={d.highlight ? { color: dirColor } : { color: "var(--foreground)" }}
                >
                  {d.value}
                </span>
              </div>
            ))}
          </div>

          {/* Builder fee disclosure (so user sees who gets the fee) */}
          {builderInfo && (
            <div className="mt-3 rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] px-3 py-2">
              <div className="text-[9px] uppercase tracking-wide text-[var(--hl-muted)] mb-1">Builder fee</div>
              <div className="text-[10.5px] text-[var(--foreground)]">
                {builderInfo.feePercent} to <span className="font-mono">{builderInfo.address.slice(0, 6)}...{builderInfo.address.slice(-4)}</span>
              </div>
              <div className="text-[9px] text-[var(--hl-muted)] mt-0.5">This is HLOne's platform fee. Verify address hasn't changed.</div>
            </div>
          )}

          {/* Warnings */}
          {warnings.length > 0 && (
            <div className="mt-3 rounded border border-[#f5a524]/40 bg-[#f5a524]/10 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-[#f5a524] font-semibold mb-1">⚠ Warnings</div>
              <ul className="text-[10.5px] text-[#f5a524] leading-snug space-y-0.5">
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <div className="flex gap-2 mt-5">
            <button
              onClick={onCancel}
              disabled={loading}
              className="flex-1 py-2.5 rounded text-[13px] text-[var(--foreground)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] border border-[var(--hl-border)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="flex-1 py-2.5 rounded text-[13px] font-semibold text-[var(--background)] hover:brightness-110 disabled:opacity-40"
              style={{ background: dirColor }}
            >
              {loading ? "Signing..." : `Sign & ${description.direction}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
