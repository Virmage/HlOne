"use client";

import { useState } from "react";

const FONTS = [
  { name: "Current (System UI)", family: 'system-ui, "Segoe UI", Roboto, sans-serif', url: null },
  { name: "Geist", family: '"Geist", sans-serif', url: "https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&display=swap" },
  { name: "Space Grotesk", family: '"Space Grotesk", sans-serif', url: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" },
  { name: "Chakra Petch", family: '"Chakra Petch", sans-serif', url: "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@300;400;500;600;700&display=swap" },
  { name: "Rajdhani", family: '"Rajdhani", sans-serif', url: "https://fonts.googleapis.com/css2?family=Rajdhani:wght@300;400;500;600;700&display=swap" },
  { name: "Orbitron", family: '"Orbitron", sans-serif', url: "https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&display=swap" },
  { name: "Exo 2", family: '"Exo 2", sans-serif', url: "https://fonts.googleapis.com/css2?family=Exo+2:wght@300;400;500;600;700&display=swap" },
  { name: "Outfit", family: '"Outfit", sans-serif', url: "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" },
  { name: "JetBrains Mono", family: '"JetBrains Mono", monospace', url: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" },
  { name: "Share Tech", family: '"Share Tech", sans-serif', url: "https://fonts.googleapis.com/css2?family=Share+Tech&display=swap" },
];

const MOCK_TOKENS = [
  { coin: "BTC", price: 71056.50, change: 2.14 },
  { coin: "ETH", price: 2187.40, change: -0.83 },
  { coin: "HYPE", price: 38.72, change: 5.61 },
  { coin: "SOL", price: 82.57, change: 1.22 },
  { coin: "FARTCOIN", price: 0.2512, change: -12.4 },
  { coin: "XRP", price: 1.3412, change: -0.31 },
  { coin: "TAO", price: 324.88, change: 3.02 },
];

const MOCK_MACRO = [
  { label: "SPX", value: "5,842.01", change: "+0.32%" },
  { label: "NDX", value: "20,412.80", change: "+0.58%" },
  { label: "DXY", value: "103.12", change: "-0.14%" },
  { label: "Gold", value: "3,012.40", change: "+0.22%" },
  { label: "VIX", value: "14.82", change: "-2.1%" },
];

function FontSection({ font, theme }: { font: typeof FONTS[0]; theme: "dark" | "light" }) {
  const isDark = theme === "dark";
  const bg = isDark ? "#060a0c" : "#faf8f5";
  const fg = isDark ? "#e4f0f4" : "#1c1a16";
  const accent = isDark ? "#00f0ff" : "#0ea5e9";
  const muted = isDark ? "#3a5058" : "#9a9488";
  const border = isDark ? "#1a2428" : "#ddd8ce";
  const surface = isDark ? "#0e1416" : "#f0ece6";
  const nav = isDark ? "#040808" : "#fdfcf9";
  const green = isDark ? "#4ade80" : "#16a34a";
  const red = isDark ? "#f87171" : "#dc2626";

  return (
    <div style={{ fontFamily: font.family, background: bg, color: fg, borderRadius: 8, overflow: "hidden", border: `1px solid ${border}` }}>
      {/* Font label */}
      <div style={{ padding: "8px 16px", background: surface, borderBottom: `1px solid ${border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: accent }}>{font.name}</span>
        <span style={{ fontSize: 11, color: muted, fontFamily: "monospace" }}>{font.family.split(",")[0].replace(/"/g, "")}</span>
      </div>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", height: 40, background: nav, borderBottom: `1px solid ${border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="20" height="14" viewBox="0 0 24 16" fill="none">
              <path d="M0 0C4 0 8 3.5 12 8C8 12.5 4 16 0 16C4 12 4 4 0 0Z" fill={accent} />
              <path d="M24 0C20 0 16 3.5 12 8C16 12.5 20 16 24 16C20 12 20 4 24 0Z" fill={accent} />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600 }}>HLOne</span>
          </div>
          <nav style={{ display: "flex", gap: 12 }}>
            {["Terminal", "Traders", "Portfolio"].map((item, i) => (
              <span key={item} style={{ fontSize: 12, fontWeight: i === 0 ? 600 : 400, color: i === 0 ? fg : muted, padding: "4px 8px", borderRadius: 6, background: i === 0 ? `${accent}11` : "transparent" }}>{item}</span>
            ))}
          </nav>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, color: accent }}>
            <span style={{ color: muted }}>Acct:</span> $11
          </span>
          <span style={{ fontSize: 11, color: green }}>
            <span style={{ color: muted }}>uPnL:</span> +$0.42
          </span>
          <button style={{ height: 28, padding: "0 16px", borderRadius: 10, fontSize: 11, fontWeight: 500, border: `1px solid ${border}`, background: surface, color: fg, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
            0x9545...Fde9
          </button>
        </div>
      </div>

      {/* Macro bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "4px 16px", borderBottom: `1px solid ${border}`, fontSize: 11 }}>
        {MOCK_MACRO.map(m => (
          <span key={m.label} style={{ display: "flex", gap: 4, color: muted }}>
            <span style={{ fontWeight: 500, color: fg }}>{m.label}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{m.value}</span>
            <span style={{ color: m.change.startsWith("+") ? green : red }}>{m.change}</span>
          </span>
        ))}
      </div>

      {/* Ticker bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "6px 12px", borderBottom: `1px solid ${border}`, overflowX: "auto" }}>
        {MOCK_TOKENS.map(t => (
          <div key={t.coin} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 6, background: surface, fontSize: 11, flexShrink: 0 }}>
            <span style={{ fontWeight: 600, color: fg }}>{t.coin}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: fg }}>${t.price.toLocaleString()}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: t.change >= 0 ? green : red, fontSize: 10 }}>
              {t.change >= 0 ? "+" : ""}{t.change.toFixed(2)}%
            </span>
          </div>
        ))}
      </div>

      {/* Market Pulse row */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "8px 16px", borderBottom: `1px solid ${border}`, fontSize: 11 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: muted, textTransform: "uppercase", fontSize: 9, letterSpacing: "0.05em" }}>Regime</span>
          <span style={{ padding: "2px 8px", borderRadius: 4, background: `${green}22`, color: green, fontWeight: 600, fontSize: 11 }}>Risk On</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: muted, textTransform: "uppercase", fontSize: 9 }}>BTC Dom</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>61.2%</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: muted, textTransform: "uppercase", fontSize: 9 }}>24h Vol</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>$4.2B</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: muted, textTransform: "uppercase", fontSize: 9 }}>Total OI</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>$8.7B</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: muted, textTransform: "uppercase", fontSize: 9 }}>Funding</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500, color: green }}>+0.0042%</span>
        </div>
      </div>

      {/* Fake chart area */}
      <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", borderBottom: `1px solid ${border}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>$71,056.50</span>
          <span style={{ fontSize: 14, fontWeight: 500, color: green }}>+2.14%</span>
          <span style={{ fontSize: 11, color: muted }}>BTC/USD Perpetual</span>
        </div>
      </div>
    </div>
  );
}

export default function FontPreviewPage() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  return (
    <div style={{ background: theme === "dark" ? "#060a0c" : "#faf8f5", minHeight: "100vh", padding: 24 }}>
      {/* Load all Google Fonts */}
      {FONTS.filter(f => f.url).map(f => (
        <link key={f.name} rel="stylesheet" href={f.url!} />
      ))}

      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: theme === "dark" ? "#e4f0f4" : "#1c1a16" }}>
            Font Preview
          </h1>
          <button
            onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}
            style={{ padding: "6px 16px", borderRadius: 8, border: `1px solid ${theme === "dark" ? "#1a2428" : "#ddd8ce"}`, background: theme === "dark" ? "#0e1416" : "#f0ece6", color: theme === "dark" ? "#e4f0f4" : "#1c1a16", fontSize: 12, fontWeight: 500, cursor: "pointer" }}
          >
            {theme === "dark" ? "Switch to Light" : "Switch to Dark"}
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {FONTS.map(font => (
            <FontSection key={font.name} font={font} theme={theme} />
          ))}
        </div>
      </div>
    </div>
  );
}
