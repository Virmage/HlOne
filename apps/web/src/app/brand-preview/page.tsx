"use client";

// Neon Cyan dark mode (shared across all Neon Cyan variants)
const neonCyanDark = {
  bg: "#060a0c", surface: "#0e1416", surfaceHover: "#161e20", nav: "#040808",
  fg: "#e4f0f4", muted: "#3a5058", text: "#6a8a94", border: "#1a2428",
  accent: "#00f0ff", green: "#4ade80", red: "#f87171",
};

const themes = [
  {
    name: "1. Lavender Slate ⭐",
    desc: "Soft violet accent on cool grays. Premium, calm, unique. No exchange uses this.",
    dark: {
      bg: "#111116", surface: "#19191f", surfaceHover: "#222229", nav: "#0e0e13",
      fg: "#e4e4ec", muted: "#5c5c6e", text: "#9292a4", border: "#252530",
      accent: "#9b8afb", green: "#4ade80", red: "#f87171",
    },
    light: {
      bg: "#f8f7fb", surface: "#efedf5", surfaceHover: "#e6e3ef", nav: "#fcfbfe",
      fg: "#1a1a24", muted: "#8b89a0", text: "#5c5a72", border: "#dddae8",
      accent: "#7c6ae8", green: "#16a34a", red: "#dc2626",
    },
  },
  {
    name: "2. Rose Quartz ⭐",
    desc: "Dusty pink accent. Editorial, distinctive. Zero crypto platforms use pink.",
    dark: {
      bg: "#121114", surface: "#1b1a1e", surfaceHover: "#252428", nav: "#0e0d10",
      fg: "#ebe8ec", muted: "#635f68", text: "#9a95a0", border: "#2a272e",
      accent: "#e8729a", green: "#4ade80", red: "#fb7185",
    },
    light: {
      bg: "#faf8f9", surface: "#f2eef0", surfaceHover: "#ebe6e9", nav: "#fdfbfc",
      fg: "#201c22", muted: "#948d98", text: "#645e68", border: "#e2dce0",
      accent: "#d4567e", green: "#16a34a", red: "#e11d48",
    },
  },
  {
    name: "3. Arctic Mono ⭐",
    desc: "Pure monochrome — no accent color. Green/red do all the talking. Ultra-clean.",
    dark: {
      bg: "#101014", surface: "#1a1a1f", surfaceHover: "#232328", nav: "#0c0c10",
      fg: "#e6e6ea", muted: "#55555e", text: "#8e8e98", border: "#26262c",
      accent: "#d0d0d8", green: "#4ade80", red: "#f87171",
    },
    light: {
      bg: "#f6f6f8", surface: "#ededf0", surfaceHover: "#e3e3e7", nav: "#fafafa",
      fg: "#18181c", muted: "#909098", text: "#55555e", border: "#d8d8de",
      accent: "#44444c", green: "#16a34a", red: "#dc2626",
    },
  },
  {
    name: "4. Neon Cyan ⭐ + Clean White light",
    desc: "Neon cyan dark you liked. Light mode: pure clean white/gray, dark accent. No blue.",
    dark: neonCyanDark,
    light: {
      bg: "#f7f7f8", surface: "#ededf0", surfaceHover: "#e4e4e7", nav: "#fafafa",
      fg: "#141418", muted: "#8c8c96", text: "#56565e", border: "#d8d8de",
      accent: "#2a2a30", green: "#16a34a", red: "#dc2626",
    },
  },
  {
    name: "5. Neon Cyan ⭐ + Warm Cream light",
    desc: "Neon cyan dark. Light mode: warm off-white, charcoal accent. Cozy contrast.",
    dark: neonCyanDark,
    light: {
      bg: "#faf8f5", surface: "#f0ece6", surfaceHover: "#e6e1da", nav: "#fdfcf9",
      fg: "#1c1a16", muted: "#9a9488", text: "#605c52", border: "#ddd8ce",
      accent: "#3a3830", green: "#16a34a", red: "#dc2626",
    },
  },
  {
    name: "6. Neon Cyan ⭐ + Lavender light",
    desc: "Neon cyan dark. Light mode: soft violet tones from Lavender Slate. Best of both.",
    dark: neonCyanDark,
    light: {
      bg: "#f8f7fb", surface: "#efedf5", surfaceHover: "#e6e3ef", nav: "#fcfbfe",
      fg: "#1a1a24", muted: "#8b89a0", text: "#5c5a72", border: "#dddae8",
      accent: "#7c6ae8", green: "#16a34a", red: "#dc2626",
    },
  },
  {
    name: "7. Neon Cyan ⭐ + Rose light",
    desc: "Neon cyan dark. Light mode: dusty pink from Rose Quartz. Unexpected combo.",
    dark: neonCyanDark,
    light: {
      bg: "#faf8f9", surface: "#f2eef0", surfaceHover: "#ebe6e9", nav: "#fdfbfc",
      fg: "#201c22", muted: "#948d98", text: "#645e68", border: "#e2dce0",
      accent: "#d4567e", green: "#16a34a", red: "#e11d48",
    },
  },
  {
    name: "8. Neon Cyan ⭐ + Mint light",
    desc: "Neon cyan dark. Light mode: very soft green-mint, no blue. Fresh and natural.",
    dark: neonCyanDark,
    light: {
      bg: "#f6faf7", surface: "#ecf2ed", surfaceHover: "#e2eae4", nav: "#fafcfa",
      fg: "#121c16", muted: "#7a9480", text: "#4a6a52", border: "#d0dcd4",
      accent: "#2a7a4a", green: "#16a34a", red: "#dc2626",
    },
  },
  {
    name: "9. Neon Cyan ⭐ + Pure B&W light",
    desc: "Neon cyan dark. Light mode: stark black & white. Maximum contrast flip.",
    dark: neonCyanDark,
    light: {
      bg: "#ffffff", surface: "#f5f5f5", surfaceHover: "#ebebeb", nav: "#ffffff",
      fg: "#000000", muted: "#888888", text: "#555555", border: "#e0e0e0",
      accent: "#000000", green: "#16a34a", red: "#dc2626",
    },
  },
  {
    name: "10. Pure Black & White",
    desc: "Absolute minimal. True #000/#fff. No gray tints. Stark, high-contrast.",
    dark: {
      bg: "#000000", surface: "#0a0a0a", surfaceHover: "#141414", nav: "#000000",
      fg: "#ffffff", muted: "#555555", text: "#888888", border: "#1c1c1c",
      accent: "#ffffff", green: "#4ade80", red: "#f87171",
    },
    light: {
      bg: "#ffffff", surface: "#f5f5f5", surfaceHover: "#ebebeb", nav: "#ffffff",
      fg: "#000000", muted: "#888888", text: "#555555", border: "#e0e0e0",
      accent: "#000000", green: "#16a34a", red: "#dc2626",
    },
  },
];

// Fake ticker data
const tickers = [
  { coin: "BTC", price: 68792.5, change: 2.34, score: 82 },
  { coin: "ETH", price: 2112.85, change: -1.12, score: 45 },
  { coin: "SOL", price: 79.86, change: 5.67, score: 71 },
  { coin: "HYPE", price: 36.45, change: 8.21, score: 88 },
  { coin: "XRP", price: 1.317, change: -0.45, score: 33 },
  { coin: "TAO", price: 312.35, change: 3.89, score: 62 },
  { coin: "ZEC", price: 262.58, change: -2.11, score: 28 },
  { coin: "FARTCOIN", price: 0.1692, change: 12.4, score: 91 },
];

const sharpFlows = [
  { coin: "SOL", price: 79.86, change: 5.67, sharpDir: "short", sharpCount: 54, sharpStr: 34, sqDir: "long", sqCount: 120, sqStr: 45, score: 78, div: true, divScore: 72 },
  { coin: "BTC", price: 68792.5, change: 2.34, sharpDir: "long", sharpCount: 97, sharpStr: 33, sqDir: "long", sqCount: 210, sqStr: 28, score: 82, div: false, divScore: 0 },
  { coin: "HYPE", price: 36.45, change: 8.21, sharpDir: "short", sharpCount: 101, sharpStr: 17, sqDir: "long", sqCount: 180, sqStr: 22, score: 55, div: false, divScore: 0 },
  { coin: "ETH", price: 2112.85, change: -1.12, sharpDir: "neutral", sharpCount: 75, sharpStr: 6, sqDir: "short", sqCount: 190, sqStr: 15, score: 45, div: false, divScore: 0 },
  { coin: "ONDO", price: 0.82, change: -3.44, sharpDir: "short", sharpCount: 7, sharpStr: 70, sqDir: "long", sqCount: 35, sqStr: 62, score: 38, div: true, divScore: 65 },
];

const whaleAlerts = [
  { name: "SwiftShark42", action: "Opened Long", coin: "BTC", size: "$2.4M", time: "2m ago", color: "green" },
  { name: "BoldEagle17", action: "Trimmed", coin: "ETH", size: "$890K", time: "5m ago", color: "red" },
  { name: "NeonWolf88", action: "Flipped Short → Long", coin: "SOL", size: "$1.1M", time: "8m ago", color: "green" },
  { name: "IronFox61", action: "Added Long", coin: "HYPE", size: "$340K", time: "12m ago", color: "green" },
];

function TerminalPreview({ theme, mode }: { theme: typeof themes[0]; mode: "dark" | "light" }) {
  const c = mode === "dark" ? theme.dark : theme.light;

  return (
    <div style={{ background: c.bg, color: c.fg, borderRadius: 8, overflow: "hidden", border: `1px solid ${c.border}` }}>
      {/* Nav */}
      <div style={{ background: c.nav, borderBottom: `1px solid ${c.border}`, padding: "8px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <span style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c.accent} strokeWidth="2.5"><path d="M7 17L17 7M7 7l10 10"/></svg>
            CPYCAT
          </span>
          <span style={{ fontSize: 12, color: c.fg, fontWeight: 500 }}>Terminal</span>
          <span style={{ fontSize: 12, color: c.muted }}>Traders</span>
          <span style={{ fontSize: 12, color: c.muted }}>Portfolio</span>
        </div>
        <button style={{ background: c.accent, color: mode === "dark" ? "#0e0e0e" : "#ffffff", fontSize: 11, fontWeight: 600, padding: "5px 14px", borderRadius: 5, border: "none", cursor: "pointer" }}>
          Connect
        </button>
      </div>

      {/* Ticker Bar */}
      <div style={{ borderBottom: `1px solid ${c.border}`, padding: "4px 0", display: "flex", overflow: "hidden", gap: 0 }}>
        {tickers.map(t => (
          <div key={t.coin} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 14px", fontSize: 11, whiteSpace: "nowrap", borderRight: `1px solid ${c.border}` }}>
            <span style={{ fontWeight: 600, color: c.text }}>{t.coin}</span>
            <span style={{ color: c.fg, fontFamily: "monospace" }}>${t.price >= 1 ? t.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : t.price.toPrecision(4)}</span>
            <span style={{ color: t.change >= 0 ? c.green : c.red, fontFamily: "monospace" }}>
              {t.change >= 0 ? "+" : ""}{t.change.toFixed(2)}%
            </span>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: t.score >= 70 ? c.green : t.score <= 30 ? c.red : c.muted, display: "inline-block" }} />
          </div>
        ))}
      </div>

      {/* Main content grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
        {/* Sharp Flow Table */}
        <div style={{ borderRight: `1px solid ${c.border}`, padding: 10 }}>
          <h3 style={{ fontSize: 11, fontWeight: 500, color: c.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Sharp Flow</h3>
          <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${c.border}`, color: c.muted }}>
                <th style={{ textAlign: "left", padding: "4px 6px", fontWeight: 400 }}>Token</th>
                <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 400 }}>Price</th>
                <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 400 }}>24h</th>
                <th style={{ textAlign: "center", padding: "4px 6px", fontWeight: 400 }}>Sharps</th>
                <th style={{ textAlign: "center", padding: "4px 6px", fontWeight: 400 }}>Squares</th>
                <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 400 }}>Score</th>
              </tr>
            </thead>
            <tbody>
              {sharpFlows.map(f => (
                <tr key={f.coin} style={{ borderBottom: `1px solid ${c.border}` }}>
                  <td style={{ padding: "5px 6px", fontWeight: 600 }}>
                    {f.coin}
                    {f.div && <span style={{ fontSize: 9, marginLeft: 4, padding: "1px 4px", borderRadius: 3, background: "rgba(234,179,8,0.15)", color: "#eab308", fontWeight: 500 }}>⚡{f.divScore}</span>}
                  </td>
                  <td style={{ textAlign: "right", padding: "5px 6px", color: c.text, fontFamily: "monospace" }}>
                    ${f.price >= 1 ? f.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : f.price.toPrecision(4)}
                  </td>
                  <td style={{ textAlign: "right", padding: "5px 6px", color: f.change >= 0 ? c.green : c.red, fontFamily: "monospace" }}>
                    {f.change >= 0 ? "+" : ""}{f.change.toFixed(2)}%
                  </td>
                  <td style={{ textAlign: "center", padding: "5px 6px" }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: f.sharpDir === "long" ? c.green : f.sharpDir === "short" ? c.red : c.muted }}>
                      {f.sharpDir === "long" ? "LONG" : f.sharpDir === "short" ? "SHORT" : "—"} {f.sharpCount}
                    </span>
                  </td>
                  <td style={{ textAlign: "center", padding: "5px 6px" }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: f.sqDir === "long" ? c.green : f.sqDir === "short" ? c.red : c.muted }}>
                      {f.sqDir === "long" ? "LONG" : f.sqDir === "short" ? "SHORT" : "—"} {f.sqCount}
                    </span>
                  </td>
                  <td style={{ textAlign: "right", padding: "5px 6px", fontWeight: 600, color: f.score >= 70 ? c.green : f.score <= 30 ? c.red : c.text }}>
                    {f.score}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Whale Feed */}
        <div style={{ padding: 10 }}>
          <h3 style={{ fontSize: 11, fontWeight: 500, color: c.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Whale Alerts</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {whaleAlerts.map((a, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderBottom: `1px solid ${c.border}` }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                    <span style={{ fontWeight: 600 }}>{a.name}</span>
                    <span style={{ color: a.color === "green" ? c.green : c.red, fontWeight: 500 }}>{a.action}</span>
                    <span style={{ fontWeight: 600 }}>{a.coin}</span>
                  </div>
                  <div style={{ fontSize: 10, color: c.muted, marginTop: 2 }}>
                    {a.size} · {a.time}
                  </div>
                </div>
                <button style={{ fontSize: 9, fontWeight: 600, padding: "3px 8px", borderRadius: 3, background: c.accent, color: mode === "dark" ? "#0e0e0e" : "#ffffff", border: "none", cursor: "pointer" }}>
                  Copy Trader
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BrandPreview() {
  return (
    <div style={{ background: "#0a0a0a", minHeight: "100vh", padding: 24, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h1 style={{ color: "#fff", fontSize: 24, fontWeight: 700, marginBottom: 8 }}>CPYCAT Brand Color Preview — Round 3</h1>
      <p style={{ color: "#888", fontSize: 13, marginBottom: 32 }}>⭐ = kept from previous rounds. Neon Cyan dark mode paired with 6 different light modes.</p>

      {themes.map((theme, i) => (
        <div key={i} style={{ marginBottom: 40 }}>
          <h2 style={{ color: "#fff", fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{theme.name}</h2>
          <p style={{ color: "#777", fontSize: 12, marginBottom: 12 }}>{theme.desc}</p>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <p style={{ color: "#666", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Dark Mode</p>
              <TerminalPreview theme={theme} mode="dark" />
            </div>
            <div>
              <p style={{ color: "#666", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Light Mode</p>
              <TerminalPreview theme={theme} mode="light" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
