"use client";

import { useState, useEffect } from "react";
import { getTerminalData } from "@/lib/api";
import type { TokenOverview } from "@/lib/api";
import { useTickerAnimation } from "@/hooks/use-ticker-animation";
import { useSafeAccount } from "@/hooks/use-safe-account";
import { useAccountInfo } from "@/hooks/use-account-info";

const TRADFI_PREFIXES = ["xyz:", "cash:", "flx:", "km:"];

function getItems(tokens: TokenOverview[]) {
  return tokens
    .filter(t => {
      if (TRADFI_PREFIXES.some(p => t.coin.startsWith(p))) return false;
      if (t.coin === "PAXG") return false;
      return t.volume24h >= 1_000_000;
    })
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 25);
}

const badgeBase = "flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--hl-border)] transition-colors text-[10px]";

// ─── Ticker scrolling left ───────────────────────────────────────────────
function TickerLeft({ tokens, label }: { tokens: TokenOverview[]; label: string }) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(110, false);
  const items = getItems(tokens);
  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)]">
      <div ref={trackRef} className="flex py-1 px-2 gap-1" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 gap-1" aria-hidden={copy === 1}>
            <div className={`${badgeBase} text-[var(--hl-muted)] font-medium`}>{label}</div>
            {items.map((t) => {
              const isPositive = t.change24h >= 0;
              return (
                <div key={`${copy}-${t.coin}`} className={badgeBase}>
                  <span className="font-bold text-[var(--foreground)]">{t.displayName || t.coin}</span>
                  <span className={`tabular-nums font-semibold ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {isPositive ? "+" : ""}{t.change24h.toFixed(2)}%
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Ticker scrolling RIGHT ─────────────────────────────────────────────
function TickerRight({ tokens }: { tokens: TokenOverview[] }) {
  const { trackRef, onMouseEnter, onMouseLeave } = useTickerAnimation(110, true); // reverse=true
  const items = getItems(tokens);
  return (
    <div className="overflow-hidden border-b border-[var(--hl-border)]">
      <div ref={trackRef} className="flex py-1 px-2 gap-1" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ willChange: "transform" }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 gap-1" aria-hidden={copy === 1}>
            {items.map((t) => {
              const isPositive = t.change24h >= 0;
              return (
                <div key={`${copy}-${t.coin}`} className={badgeBase}>
                  <span className="font-bold text-[var(--foreground)]">{t.displayName || t.coin}</span>
                  <span className="text-[var(--hl-muted)] tabular-nums">
                    ${t.price >= 1 ? t.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : t.price.toPrecision(4)}
                  </span>
                  <span className={`tabular-nums font-semibold ${isPositive ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
                    {isPositive ? "+" : ""}{t.change24h.toFixed(2)}%
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Mini portfolio strip (for top bar) ──────────────────────────────────
function PortfolioStrip() {
  const accountInfo = useAccountInfo();
  // Demo data if not connected
  const acctVal = accountInfo?.accountValue ?? 12450.32;
  const uPnl = accountInfo?.unrealizedPnl ?? 342.18;

  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[10px] border-b border-[var(--hl-border)] bg-[var(--hl-surface)]">
      <div className="flex items-center gap-1.5">
        <span className="text-[var(--hl-muted)]">Equity</span>
        <span className="text-[var(--foreground)] font-bold tabular-nums">${acctVal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
      </div>
      <span className="text-[var(--hl-border)]">|</span>
      <div className="flex items-center gap-1.5">
        <span className="text-[var(--hl-muted)]">uPnL</span>
        <span className={`font-bold tabular-nums ${uPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
          {uPnl >= 0 ? "+" : ""}${uPnl.toFixed(2)}
        </span>
      </div>
      <span className="text-[var(--hl-border)]">|</span>
      <div className="flex items-center gap-1.5">
        <span className="text-[var(--hl-muted)]">Available</span>
        <span className="text-[var(--foreground)] tabular-nums">${(acctVal * 0.6).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      </div>
      <span className="text-[var(--hl-border)]">|</span>
      <div className="flex items-center gap-1.5">
        <span className="text-[var(--hl-muted)]">Margin</span>
        <span className="text-[var(--foreground)] tabular-nums">${(acctVal * 0.4).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      </div>
    </div>
  );
}

// ─── Mini portfolio sidebar (left of chart) ──────────────────────────────
function PortfolioSidebar() {
  const accountInfo = useAccountInfo();
  const acctVal = accountInfo?.accountValue ?? 12450.32;
  const uPnl = accountInfo?.unrealizedPnl ?? 342.18;

  const stats = [
    { label: "Equity", value: `$${acctVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, color: "" },
    { label: "uPnL", value: `${uPnl >= 0 ? "+" : ""}$${uPnl.toFixed(2)}`, color: uPnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]" },
    { label: "Available", value: `$${(acctVal * 0.6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`, color: "" },
    { label: "Margin", value: `$${(acctVal * 0.4).toLocaleString(undefined, { maximumFractionDigits: 0 })}`, color: "" },
    { label: "24h PnL", value: "+$128.50", color: "text-[var(--hl-green)]" },
    { label: "7d PnL", value: "+$892.30", color: "text-[var(--hl-green)]" },
    { label: "Max DD", value: "-4.2%", color: "text-[var(--hl-red)]" },
    { label: "Win Rate", value: "62%", color: "" },
  ];

  return (
    <div className="w-[140px] flex-shrink-0 border-r border-[var(--hl-border)] py-2 px-2 overflow-y-auto">
      <div className="text-[9px] font-bold text-[var(--hl-muted)] uppercase tracking-wider mb-2">Portfolio</div>
      <div className="space-y-2">
        {stats.map(s => (
          <div key={s.label}>
            <div className="text-[8px] text-[var(--hl-muted)] uppercase tracking-wider">{s.label}</div>
            <div className={`text-[12px] font-bold tabular-nums ${s.color || "text-[var(--foreground)]"}`}>{s.value}</div>
          </div>
        ))}
      </div>
      {/* Mini equity sparkline placeholder */}
      <div className="mt-3 pt-2 border-t border-[var(--hl-border)]">
        <div className="text-[8px] text-[var(--hl-muted)] uppercase tracking-wider mb-1">Equity Curve</div>
        <div className="h-[40px] bg-[var(--hl-surface)] rounded flex items-end px-0.5 gap-px">
          {[40, 45, 42, 48, 44, 50, 52, 49, 55, 58, 54, 60, 56, 62, 65, 60, 68, 70].map((v, i) => (
            <div key={i} className="flex-1 bg-[var(--hl-green)] rounded-t opacity-60" style={{ height: `${v}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Fake chart placeholder ──────────────────────────────────────────────
function FakeChart({ height }: { height: string }) {
  return (
    <div className={`${height} bg-[var(--hl-surface)] flex items-center justify-center text-[var(--hl-muted)] text-[12px]`}>
      [ Price Chart ]
    </div>
  );
}

function FakeOrderBook() {
  return (
    <div className="w-[140px] h-full bg-[var(--hl-surface)] flex items-center justify-center text-[var(--hl-muted)] text-[9px]">
      [ Order Book ]
    </div>
  );
}

function FakeTradingPanel() {
  return (
    <div className="w-[200px] h-full bg-[var(--hl-surface)] flex items-center justify-center text-[var(--hl-muted)] text-[9px]">
      [ Trading Panel ]
    </div>
  );
}

function FakePositions() {
  return (
    <div className="h-[80px] flex items-center justify-center text-[var(--hl-muted)] text-[9px] border-t border-[var(--hl-border)]">
      [ Positions / Balances / Orders ]
    </div>
  );
}

export default function LayoutPreview() {
  const [tokens, setTokens] = useState<TokenOverview[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTerminalData()
      .then(d => setTokens(d.tokens || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-[var(--hl-muted)]">Loading...</div>;

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* ═══ OPTION A: Portfolio in top bar strip ═══ */}
      <div className="border-b-4 border-[var(--hl-accent)] mb-8">
        <div className="px-4 py-2 bg-[var(--hl-surface)]">
          <span className="text-[13px] font-bold text-[var(--foreground)]">Option A — Portfolio in top strip</span>
          <span className="text-[10px] text-[var(--hl-muted)] ml-2">Chart stays full width, portfolio data as a thin bar</span>
        </div>

        {/* Tickers: row 1 left, row 2 RIGHT, row 3 left */}
        <TickerLeft tokens={tokens} label="TradFi" />
        <TickerRight tokens={tokens} />
        <TickerLeft tokens={tokens} label="Options" />

        {/* Portfolio strip */}
        <PortfolioStrip />

        {/* Chart area */}
        <div className="flex border-b border-[var(--hl-border)]">
          <div className="flex-1 min-w-0 flex flex-col">
            <FakeChart height="h-[300px]" />
            <FakePositions />
          </div>
          <div className="flex border-l border-[var(--hl-border)]">
            <FakeOrderBook />
            <FakeTradingPanel />
          </div>
        </div>
      </div>

      {/* ═══ OPTION B: Portfolio sidebar left of chart ═══ */}
      <div className="border-b-4 border-purple-500 mb-8">
        <div className="px-4 py-2 bg-[var(--hl-surface)]">
          <span className="text-[13px] font-bold text-[var(--foreground)]">Option B — Portfolio sidebar left of chart</span>
          <span className="text-[10px] text-[var(--hl-muted)] ml-2">Chart narrower, portfolio metrics + mini equity curve on left</span>
        </div>

        {/* Tickers: row 1 left, row 2 RIGHT, row 3 left */}
        <TickerLeft tokens={tokens} label="TradFi" />
        <TickerRight tokens={tokens} />
        <TickerLeft tokens={tokens} label="Options" />

        {/* Chart area with portfolio sidebar */}
        <div className="flex border-b border-[var(--hl-border)]">
          <PortfolioSidebar />
          <div className="flex-1 min-w-0 flex flex-col">
            <FakeChart height="h-[300px]" />
            <FakePositions />
          </div>
          <div className="flex border-l border-[var(--hl-border)]">
            <FakeOrderBook />
            <FakeTradingPanel />
          </div>
        </div>
      </div>

      {/* ═══ OPTION C: Combined — portfolio in header + sidebar ═══ */}
      <div className="border-b-4 border-[var(--hl-green)]">
        <div className="px-4 py-2 bg-[var(--hl-surface)]">
          <span className="text-[13px] font-bold text-[var(--foreground)]">Option C — Portfolio strip + compact sidebar</span>
          <span className="text-[10px] text-[var(--hl-muted)] ml-2">Key numbers in strip, detailed stats in narrow sidebar</span>
        </div>

        {/* Tickers: row 1 left, row 2 RIGHT, row 3 left */}
        <TickerLeft tokens={tokens} label="TradFi" />
        <TickerRight tokens={tokens} />
        <TickerLeft tokens={tokens} label="Options" />
        <PortfolioStrip />

        {/* Chart area with mini sidebar */}
        <div className="flex border-b border-[var(--hl-border)]">
          {/* Narrow stats sidebar */}
          <div className="w-[100px] flex-shrink-0 border-r border-[var(--hl-border)] py-2 px-1.5 space-y-1.5">
            {[
              { l: "24h PnL", v: "+$128", c: "text-[var(--hl-green)]" },
              { l: "7d PnL", v: "+$892", c: "text-[var(--hl-green)]" },
              { l: "Win Rate", v: "62%", c: "" },
              { l: "Max DD", v: "-4.2%", c: "text-[var(--hl-red)]" },
              { l: "Sharpe", v: "1.8", c: "" },
              { l: "Avg Trade", v: "$42", c: "" },
              { l: "Trades/d", v: "8.4", c: "" },
            ].map(s => (
              <div key={s.l}>
                <div className="text-[7px] text-[var(--hl-muted)] uppercase tracking-wider">{s.l}</div>
                <div className={`text-[11px] font-bold tabular-nums ${s.c || "text-[var(--foreground)]"}`}>{s.v}</div>
              </div>
            ))}
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            <FakeChart height="h-[300px]" />
            <FakePositions />
          </div>
          <div className="flex border-l border-[var(--hl-border)]">
            <FakeOrderBook />
            <FakeTradingPanel />
          </div>
        </div>
      </div>

      <div className="h-20" />
    </div>
  );
}
