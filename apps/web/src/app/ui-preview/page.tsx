"use client";

const c = {
  bg: "#060a0c", surface: "#0e1416", surfaceHover: "#161e20", nav: "#040808",
  fg: "#e4f0f4", muted: "#3a5058", text: "#6a8a94", border: "#1a2428",
  accent: "#00f0ff", green: "#4ade80", red: "#f87171",
};

const tickers = [
  { coin: "BTC", price: 68792.5, change: 2.34 },
  { coin: "ETH", price: 2112.85, change: -1.12 },
  { coin: "SOL", price: 79.86, change: 5.67 },
  { coin: "HYPE", price: 36.45, change: 8.21 },
  { coin: "XRP", price: 1.317, change: -0.45 },
  { coin: "TAO", price: 312.35, change: 3.89 },
];

const flows = [
  { coin: "SOL", price: "$79.86", ch: "+5.67%", chUp: true, sharps: "SHORT 54", sq: "LONG 120", score: 78, div: 72, shC: false, sqC: true },
  { coin: "BTC", price: "$68,792.5", ch: "+2.34%", chUp: true, sharps: "LONG 97", sq: "LONG 210", score: 82, div: 0, shC: true, sqC: true },
  { coin: "HYPE", price: "$36.45", ch: "+8.21%", chUp: true, sharps: "SHORT 101", sq: "LONG 180", score: 55, div: 0, shC: false, sqC: true },
  { coin: "ETH", price: "$2,112.85", ch: "-1.12%", chUp: false, sharps: "— 75", sq: "SHORT 190", score: 45, div: 0, shC: false, sqC: false },
  { coin: "ONDO", price: "$0.8200", ch: "-3.44%", chUp: false, sharps: "SHORT 7", sq: "LONG 35", score: 38, div: 65, shC: false, sqC: true },
];

const whales = [
  { name: "SwiftShark42", action: "Opened Long", coin: "BTC", size: "$2.4M", time: "2m", up: true },
  { name: "BoldEagle17", action: "Trimmed", coin: "ETH", size: "$890K", time: "5m", up: false },
  { name: "NeonWolf88", action: "Flipped Short → Long", coin: "SOL", size: "$1.1M", time: "8m", up: true },
  { name: "IronFox61", action: "Added Long", coin: "HYPE", size: "$340K", time: "12m", up: true },
];

const fmt = (p: number) => p >= 1 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p.toPrecision(4);

/* ─────────────────────────────────────────────────────────────────────────── */
/* OPTION A — Curved & Seamless                                               */
/* Rounded outer shell. NO inner card borders. Sections separated by thin     */
/* divider lines. Content breathes inside one unified surface.                */
/* ─────────────────────────────────────────────────────────────────────────── */
function OptionA() {
  return (
    <div style={{ background: c.bg, borderRadius: 16, overflow: "hidden" }}>
      {/* Nav */}
      <div style={{ background: c.nav, padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${c.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: c.fg, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c.accent} strokeWidth="2.5"><path d="M7 17L17 7M7 7l10 10"/></svg>
            HLOne
          </span>
          <div style={{ display: "flex", gap: 2, marginLeft: 16, background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: c.fg, padding: "5px 14px", borderRadius: 8, background: "rgba(0,240,255,0.08)" }}>Terminal</span>
            <span style={{ fontSize: 11, color: c.muted, padding: "5px 14px" }}>Traders</span>
            <span style={{ fontSize: 11, color: c.muted, padding: "5px 14px" }}>Portfolio</span>
          </div>
        </div>
        <button style={{ background: c.accent, color: "#060a0c", fontSize: 11, fontWeight: 600, padding: "6px 18px", borderRadius: 10, border: "none" }}>Connect</button>
      </div>

      {/* Ticker — pill chips, no outer box */}
      <div style={{ padding: "10px 20px", display: "flex", gap: 6, borderBottom: `1px solid ${c.border}`, overflow: "hidden" }}>
        {tickers.map(t => (
          <div key={t.coin} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", fontSize: 11, background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
            <span style={{ fontWeight: 600, color: c.fg }}>{t.coin}</span>
            <span style={{ color: c.text, fontFamily: "monospace" }}>${fmt(t.price)}</span>
            <span style={{ color: t.change >= 0 ? c.green : c.red, fontFamily: "monospace", fontWeight: 500 }}>{t.change >= 0 ? "+" : ""}{t.change.toFixed(2)}%</span>
          </div>
        ))}
      </div>

      {/* Content — two columns, NO card borders, just a vertical divider */}
      <div style={{ display: "flex" }}>
        {/* Left: Sharp Flow */}
        <div style={{ flex: 1, padding: "14px 20px", borderRight: `1px solid ${c.border}` }}>
          <h3 style={{ fontSize: 10, fontWeight: 600, color: c.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Sharp Flow</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 0.8fr 1fr 1fr 0.5fr", fontSize: 10, color: c.muted, padding: "0 0 6px", borderBottom: `1px solid ${c.border}` }}>
            <span>Token</span><span style={{ textAlign: "right" }}>Price</span><span style={{ textAlign: "right" }}>24h</span>
            <span style={{ textAlign: "center" }}>Sharps</span><span style={{ textAlign: "center" }}>Squares</span><span style={{ textAlign: "right" }}>Score</span>
          </div>
          {flows.map(f => (
            <div key={f.coin} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 0.8fr 1fr 1fr 0.5fr", fontSize: 11, padding: "7px 0", borderBottom: `1px solid rgba(26,36,40,0.5)`, alignItems: "center" }}>
              <span style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                {f.coin}
                {f.div > 0 && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 4, background: "rgba(234,179,8,0.12)", color: "#eab308" }}>⚡{f.div}</span>}
              </span>
              <span style={{ textAlign: "right", color: c.text, fontFamily: "monospace" }}>{f.price}</span>
              <span style={{ textAlign: "right", color: f.chUp ? c.green : c.red, fontFamily: "monospace" }}>{f.ch}</span>
              <span style={{ textAlign: "center", fontSize: 10, fontWeight: 600, color: f.shC ? c.green : c.red }}>{f.sharps}</span>
              <span style={{ textAlign: "center", fontSize: 10, fontWeight: 600, color: f.sqC ? c.green : c.red }}>{f.sq}</span>
              <span style={{ textAlign: "right", fontWeight: 600, color: f.score >= 70 ? c.green : c.text }}>{f.score}</span>
            </div>
          ))}
        </div>
        {/* Right: Whales */}
        <div style={{ flex: 1, padding: "14px 20px" }}>
          <h3 style={{ fontSize: 10, fontWeight: 600, color: c.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Whale Alerts</h3>
          {whales.map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid rgba(26,36,40,0.5)` }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                  <span style={{ fontWeight: 600, color: c.fg }}>{a.name}</span>
                  <span style={{ color: a.up ? c.green : c.red, fontWeight: 500 }}>{a.action}</span>
                  <span style={{ fontWeight: 600, color: c.fg }}>{a.coin}</span>
                </div>
                <div style={{ fontSize: 10, color: c.muted, marginTop: 2 }}>{a.size} · {a.time} ago</div>
              </div>
              <button style={{ fontSize: 9, fontWeight: 600, padding: "4px 10px", borderRadius: 8, background: "rgba(0,240,255,0.08)", color: c.accent, border: `1px solid rgba(0,240,255,0.15)` }}>Copy</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* OPTION B — Apple Unified                                                    */
/* One surface, generous spacing, rounded rows that float on the bg.          */
/* No card containers at all. Sections have headers + content directly.       */
/* Rows have very subtle highlight on hover-style background.                 */
/* ─────────────────────────────────────────────────────────────────────────── */
function OptionB() {
  return (
    <div style={{ background: c.bg, borderRadius: 20, overflow: "hidden" }}>
      {/* Nav */}
      <div style={{ padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${c.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: c.fg, display: "flex", alignItems: "center", gap: 6, letterSpacing: "-0.02em" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c.accent} strokeWidth="2.5"><path d="M7 17L17 7M7 7l10 10"/></svg>
            HLOne
          </span>
          <div style={{ display: "flex", gap: 2, marginLeft: 20, background: "rgba(255,255,255,0.03)", borderRadius: 12, padding: 3 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: c.fg, padding: "6px 16px", borderRadius: 10, background: "rgba(0,240,255,0.07)" }}>Terminal</span>
            <span style={{ fontSize: 12, color: c.muted, padding: "6px 16px" }}>Traders</span>
            <span style={{ fontSize: 12, color: c.muted, padding: "6px 16px" }}>Portfolio</span>
          </div>
        </div>
        <button style={{ background: c.accent, color: "#060a0c", fontSize: 12, fontWeight: 600, padding: "7px 20px", borderRadius: 12, border: "none" }}>Connect</button>
      </div>

      {/* Ticker — inline, no boxes */}
      <div style={{ padding: "12px 24px", display: "flex", gap: 20, borderBottom: `1px solid ${c.border}`, overflow: "hidden" }}>
        {tickers.map(t => (
          <div key={t.coin} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12 }}>
            <span style={{ fontWeight: 700, color: c.fg }}>{t.coin}</span>
            <span style={{ color: c.text, fontFamily: "monospace", fontSize: 12 }}>${fmt(t.price)}</span>
            <span style={{ color: t.change >= 0 ? c.green : c.red, fontFamily: "monospace", fontSize: 11, fontWeight: 500 }}>{t.change >= 0 ? "+" : ""}{t.change.toFixed(2)}%</span>
          </div>
        ))}
      </div>

      {/* Content */}
      <div style={{ display: "flex" }}>
        {/* Left */}
        <div style={{ flex: 1, padding: "16px 24px", borderRight: `1px solid ${c.border}` }}>
          <h3 style={{ fontSize: 11, fontWeight: 500, color: c.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Sharp Flow</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 0.8fr 1fr 1fr 0.5fr", fontSize: 10, color: c.muted, padding: "0 8px 8px" }}>
            <span>Token</span><span style={{ textAlign: "right" }}>Price</span><span style={{ textAlign: "right" }}>24h</span>
            <span style={{ textAlign: "center" }}>Sharps</span><span style={{ textAlign: "center" }}>Squares</span><span style={{ textAlign: "right" }}>Score</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {flows.map(f => (
              <div key={f.coin} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 0.8fr 1fr 1fr 0.5fr", fontSize: 11, padding: "8px 8px", borderRadius: 10, background: "rgba(255,255,255,0.02)", alignItems: "center" }}>
                <span style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                  {f.coin}
                  {f.div > 0 && <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 6, background: "rgba(234,179,8,0.12)", color: "#eab308" }}>⚡{f.div}</span>}
                </span>
                <span style={{ textAlign: "right", color: c.text, fontFamily: "monospace" }}>{f.price}</span>
                <span style={{ textAlign: "right", color: f.chUp ? c.green : c.red, fontFamily: "monospace" }}>{f.ch}</span>
                <span style={{ textAlign: "center", fontSize: 10, fontWeight: 600, color: f.shC ? c.green : c.red }}>{f.sharps}</span>
                <span style={{ textAlign: "center", fontSize: 10, fontWeight: 600, color: f.sqC ? c.green : c.red }}>{f.sq}</span>
                <span style={{ textAlign: "right", fontWeight: 600, color: f.score >= 70 ? c.green : c.text }}>{f.score}</span>
              </div>
            ))}
          </div>
        </div>
        {/* Right */}
        <div style={{ flex: 1, padding: "16px 24px" }}>
          <h3 style={{ fontSize: 11, fontWeight: 500, color: c.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Whale Alerts</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {whales.map((a, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 10px", borderRadius: 10, background: "rgba(255,255,255,0.02)" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                    <span style={{ fontWeight: 600, color: c.fg }}>{a.name}</span>
                    <span style={{ color: a.up ? c.green : c.red, fontWeight: 500 }}>{a.action}</span>
                    <span style={{ fontWeight: 600, color: c.fg }}>{a.coin}</span>
                  </div>
                  <div style={{ fontSize: 10, color: c.muted, marginTop: 3 }}>{a.size} · {a.time} ago</div>
                </div>
                <button style={{ fontSize: 10, fontWeight: 600, padding: "5px 12px", borderRadius: 10, background: "rgba(0,240,255,0.07)", color: c.accent, border: "none" }}>Copy</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* OPTION C — Floating Sections                                                */
/* No outer box at all. Nav is its own rounded bar. Sections are separated    */
/* by space, not borders. Each section header + content sits in open air.     */
/* The page IS the dark background.                                           */
/* ─────────────────────────────────────────────────────────────────────────── */
function OptionC() {
  return (
    <div style={{ background: c.bg, borderRadius: 16, overflow: "hidden", padding: 0 }}>
      {/* Nav — floating bar */}
      <div style={{ margin: "12px 16px 0", padding: "8px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: c.surface, borderRadius: 14, border: `1px solid ${c.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: c.fg, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c.accent} strokeWidth="2.5"><path d="M7 17L17 7M7 7l10 10"/></svg>
            HLOne
          </span>
          <div style={{ display: "flex", gap: 2, marginLeft: 12, background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: c.fg, padding: "5px 14px", borderRadius: 8, background: "rgba(0,240,255,0.08)" }}>Terminal</span>
            <span style={{ fontSize: 11, color: c.muted, padding: "5px 14px" }}>Traders</span>
            <span style={{ fontSize: 11, color: c.muted, padding: "5px 14px" }}>Portfolio</span>
          </div>
        </div>
        <button style={{ background: c.accent, color: "#060a0c", fontSize: 11, fontWeight: 600, padding: "6px 18px", borderRadius: 10, border: "none" }}>Connect</button>
      </div>

      {/* Ticker — floating row */}
      <div style={{ margin: "10px 16px 0", padding: "8px 14px", display: "flex", gap: 16, overflow: "hidden", background: c.surface, borderRadius: 12, border: `1px solid ${c.border}` }}>
        {tickers.map(t => (
          <div key={t.coin} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 11 }}>
            <span style={{ fontWeight: 700, color: c.fg }}>{t.coin}</span>
            <span style={{ color: c.text, fontFamily: "monospace" }}>${fmt(t.price)}</span>
            <span style={{ color: t.change >= 0 ? c.green : c.red, fontFamily: "monospace", fontWeight: 500 }}>{t.change >= 0 ? "+" : ""}{t.change.toFixed(2)}%</span>
          </div>
        ))}
      </div>

      {/* Content — two sections side by side, each with own surface */}
      <div style={{ display: "flex", gap: 10, padding: "10px 16px 16px" }}>
        {/* Left */}
        <div style={{ flex: 1 }}>
          <h3 style={{ fontSize: 10, fontWeight: 600, color: c.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8, paddingLeft: 4 }}>Sharp Flow</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 0.8fr 1fr 1fr 0.5fr", fontSize: 10, color: c.muted, padding: "0 8px 6px" }}>
            <span>Token</span><span style={{ textAlign: "right" }}>Price</span><span style={{ textAlign: "right" }}>24h</span>
            <span style={{ textAlign: "center" }}>Sharps</span><span style={{ textAlign: "center" }}>Squares</span><span style={{ textAlign: "right" }}>Score</span>
          </div>
          {flows.map(f => (
            <div key={f.coin} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 0.8fr 1fr 1fr 0.5fr", fontSize: 11, padding: "7px 8px", alignItems: "center", borderBottom: `1px solid rgba(26,36,40,0.4)` }}>
              <span style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                {f.coin}
                {f.div > 0 && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 4, background: "rgba(234,179,8,0.12)", color: "#eab308" }}>⚡{f.div}</span>}
              </span>
              <span style={{ textAlign: "right", color: c.text, fontFamily: "monospace" }}>{f.price}</span>
              <span style={{ textAlign: "right", color: f.chUp ? c.green : c.red, fontFamily: "monospace" }}>{f.ch}</span>
              <span style={{ textAlign: "center", fontSize: 10, fontWeight: 600, color: f.shC ? c.green : c.red }}>{f.sharps}</span>
              <span style={{ textAlign: "center", fontSize: 10, fontWeight: 600, color: f.sqC ? c.green : c.red }}>{f.sq}</span>
              <span style={{ textAlign: "right", fontWeight: 600, color: f.score >= 70 ? c.green : c.text }}>{f.score}</span>
            </div>
          ))}
        </div>
        {/* Right */}
        <div style={{ flex: 1 }}>
          <h3 style={{ fontSize: 10, fontWeight: 600, color: c.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8, paddingLeft: 4 }}>Whale Alerts</h3>
          {whales.map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 8px", borderBottom: `1px solid rgba(26,36,40,0.4)` }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                  <span style={{ fontWeight: 600, color: c.fg }}>{a.name}</span>
                  <span style={{ color: a.up ? c.green : c.red, fontWeight: 500 }}>{a.action}</span>
                  <span style={{ fontWeight: 600, color: c.fg }}>{a.coin}</span>
                </div>
                <div style={{ fontSize: 10, color: c.muted, marginTop: 2 }}>{a.size} · {a.time} ago</div>
              </div>
              <button style={{ fontSize: 9, fontWeight: 600, padding: "4px 10px", borderRadius: 8, background: "rgba(0,240,255,0.07)", color: c.accent, border: "none" }}>Copy</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* OPTION D — Soft Dividers Only                                               */
/* Outer rounded shell. Content separated ONLY by very faint horizontal/      */
/* vertical lines. Rounded pill nav, rounded buttons. Rows are flat with      */
/* dividers — no row backgrounds at all. Maximum clean.                       */
/* ─────────────────────────────────────────────────────────────────────────── */
function OptionD() {
  const divider = `1px solid rgba(26,36,40,0.6)`;
  return (
    <div style={{ background: c.surface, borderRadius: 18, overflow: "hidden", border: `1px solid ${c.border}` }}>
      {/* Nav */}
      <div style={{ padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: divider }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: c.fg, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c.accent} strokeWidth="2.5"><path d="M7 17L17 7M7 7l10 10"/></svg>
            HLOne
          </span>
          <div style={{ display: "flex", gap: 16, marginLeft: 20 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: c.fg, borderBottom: `2px solid ${c.accent}`, paddingBottom: 2 }}>Terminal</span>
            <span style={{ fontSize: 12, color: c.muted }}>Traders</span>
            <span style={{ fontSize: 12, color: c.muted }}>Portfolio</span>
          </div>
        </div>
        <button style={{ background: "transparent", color: c.accent, fontSize: 11, fontWeight: 600, padding: "5px 16px", borderRadius: 20, border: `1px solid ${c.accent}` }}>Connect</button>
      </div>

      {/* Ticker */}
      <div style={{ padding: "8px 20px", display: "flex", gap: 20, borderBottom: divider, overflow: "hidden" }}>
        {tickers.map(t => (
          <div key={t.coin} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 11 }}>
            <span style={{ fontWeight: 600, color: c.fg }}>{t.coin}</span>
            <span style={{ color: c.text, fontFamily: "monospace" }}>${fmt(t.price)}</span>
            <span style={{ color: t.change >= 0 ? c.green : c.red, fontFamily: "monospace", fontWeight: 500 }}>{t.change >= 0 ? "+" : ""}{t.change.toFixed(2)}%</span>
          </div>
        ))}
      </div>

      {/* Content */}
      <div style={{ display: "flex" }}>
        <div style={{ flex: 1, padding: "14px 20px", borderRight: divider }}>
          <h3 style={{ fontSize: 10, fontWeight: 600, color: c.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Sharp Flow</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 0.8fr 1fr 1fr 0.5fr", fontSize: 10, color: c.muted, padding: "0 0 6px", borderBottom: divider }}>
            <span>Token</span><span style={{ textAlign: "right" }}>Price</span><span style={{ textAlign: "right" }}>24h</span>
            <span style={{ textAlign: "center" }}>Sharps</span><span style={{ textAlign: "center" }}>Squares</span><span style={{ textAlign: "right" }}>Score</span>
          </div>
          {flows.map(f => (
            <div key={f.coin} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 0.8fr 1fr 1fr 0.5fr", fontSize: 11, padding: "8px 0", borderBottom: divider, alignItems: "center" }}>
              <span style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                {f.coin}
                {f.div > 0 && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 4, background: "rgba(234,179,8,0.12)", color: "#eab308" }}>⚡{f.div}</span>}
              </span>
              <span style={{ textAlign: "right", color: c.text, fontFamily: "monospace" }}>{f.price}</span>
              <span style={{ textAlign: "right", color: f.chUp ? c.green : c.red, fontFamily: "monospace" }}>{f.ch}</span>
              <span style={{ textAlign: "center", fontSize: 10, fontWeight: 600, color: f.shC ? c.green : c.red }}>{f.sharps}</span>
              <span style={{ textAlign: "center", fontSize: 10, fontWeight: 600, color: f.sqC ? c.green : c.red }}>{f.sq}</span>
              <span style={{ textAlign: "right", fontWeight: 600, color: f.score >= 70 ? c.green : c.text }}>{f.score}</span>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, padding: "14px 20px" }}>
          <h3 style={{ fontSize: 10, fontWeight: 600, color: c.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Whale Alerts</h3>
          {whales.map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: divider }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                  <span style={{ fontWeight: 600, color: c.fg }}>{a.name}</span>
                  <span style={{ color: a.up ? c.green : c.red, fontWeight: 500 }}>{a.action}</span>
                  <span style={{ fontWeight: 600, color: c.fg }}>{a.coin}</span>
                </div>
                <div style={{ fontSize: 10, color: c.muted, marginTop: 2 }}>{a.size} · {a.time} ago</div>
              </div>
              <button style={{ fontSize: 9, fontWeight: 600, padding: "4px 12px", borderRadius: 20, background: "transparent", color: c.accent, border: `1px solid rgba(0,240,255,0.2)` }}>Copy</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function UIPreviewPage() {
  const options = [
    { name: "A. Curved & Seamless", desc: "Rounded outer shell. NO inner cards. Sections split by thin dividers. Pill nav, pill ticker chips. One unified surface.", comp: <OptionA /> },
    { name: "B. Apple Unified", desc: "Generous spacing. Rounded rows float on subtle bg tint — no borders on them. Ticker is inline text (no boxes). Breathing room everywhere.", comp: <OptionB /> },
    { name: "C. Floating Sections", desc: "Nav and ticker are floating rounded bars. Content sections sit in open air below — no outer container wrapping everything. Page bg IS the dark.", comp: <OptionC /> },
    { name: "D. Soft Dividers", desc: "One rounded shell. Content separated ONLY by faint lines. No row backgrounds. Underline nav. Outlined buttons. Maximum minimal.", comp: <OptionD /> },
  ];

  return (
    <div style={{ background: "#030606", minHeight: "100vh", padding: 24, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h1 style={{ color: "#e4f0f4", fontSize: 24, fontWeight: 700, marginBottom: 4 }}>HLOne UI Design — No Box-in-Box</h1>
      <p style={{ color: "#6a8a94", fontSize: 13, marginBottom: 36 }}>All curved. No nested card borders. Sections flow together.</p>

      {options.map((opt, i) => (
        <div key={i} style={{ marginBottom: 52 }}>
          <h2 style={{ color: "#e4f0f4", fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{opt.name}</h2>
          <p style={{ color: "#3a5058", fontSize: 12, marginBottom: 14 }}>{opt.desc}</p>
          {opt.comp}
        </div>
      ))}
    </div>
  );
}
