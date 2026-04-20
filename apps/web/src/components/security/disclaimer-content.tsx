"use client";

/**
 * Shared disclaimer body — rendered both in the first-visit acknowledgment
 * modal and in a view-only modal accessible from the Security page.
 */

export function DisclaimerBullets() {
  return (
    <div className="space-y-3">
      <Bullet
        title="This project is vibe coded"
        body="Built by one person with AI pair-programming assistance. Code has not been independently audited."
      />
      <Bullet
        title="Safety is best-effort, not guaranteed"
        body="Reasonable precautions have been taken — no custody of your funds, signatures happen in your wallet, keys stored locally. But bugs, edge cases, and vulnerabilities may exist."
      />
      <Bullet
        title="Use at your own risk"
        body="Trade with amounts you can afford to lose. HLOne is not responsible for any financial loss, technical failure, or unintended behavior resulting from use of this software."
      />
    </div>
  );
}

function Bullet({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="text-[var(--hl-accent)] shrink-0 mt-0.5">•</span>
      <div>
        <div className="text-[12px] text-[var(--foreground)] font-medium">{title}</div>
        <div className="text-[11px] text-[var(--hl-muted)] leading-snug mt-0.5">{body}</div>
      </div>
    </div>
  );
}

/** Read-only view of the disclaimer (no checkbox, just close button). */
export function DisclaimerViewModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[99998] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[500px] bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="h-1 bg-gradient-to-r from-[var(--hl-accent)] via-[#f5a524] to-[var(--hl-accent)]" />
        <div className="p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-[18px]">⚠️</span>
              <h2 className="text-[16px] font-semibold text-[var(--foreground)]">HLOne disclaimer</h2>
            </div>
            <button
              onClick={onClose}
              className="text-[var(--hl-muted)] hover:text-[var(--foreground)] transition-colors text-[20px] leading-none"
              aria-label="Close"
            >
              &times;
            </button>
          </div>
          <p className="text-[11px] text-[var(--hl-muted)] leading-relaxed mb-4">
            The disclaimer you acknowledged on first visit:
          </p>
          <DisclaimerBullets />
          <button
            onClick={onClose}
            className="w-full mt-5 py-2 rounded text-[12px] text-[var(--foreground)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] border border-[var(--hl-border)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
