/**
 * HLOne Studio — Starter templates.
 *
 * 5 preset configurations that builders can start from. Each is a complete
 * StudioConfig with a descriptive label shown in the template picker.
 */

import { type StudioConfig, STUDIO_CONFIG_VERSION, type WidgetKey } from "./studio-config";

export interface StudioTemplate {
  id: string;
  name: string;
  tagline: string;
  description: string;
  config: StudioConfig;
}

// Helper to build widget flags from a subset
function widgetsFrom(enabled: WidgetKey[]): Partial<Record<WidgetKey, boolean>> {
  const all = [
    "tickerBar", "priceChart", "tradingPanel", "orderBook", "positionsPanel", "marketPulse",
    "sharpFlowTable", "whaleFeed", "whaleAccumulation", "largeTradeTape", "signalsPanel",
    "divergencePanel", "positionConcentration", "fundingLeaderboard", "lendingRates",
    "socialPanel", "newsFeed", "deribitFlow", "deriveOptions", "ecosystemPanel", "copyTradePanel",
  ] as WidgetKey[];
  const map = {} as Partial<Record<WidgetKey, boolean>>;
  for (const k of all) map[k] = enabled.includes(k);
  return map;
}

export const STUDIO_TEMPLATES: StudioTemplate[] = [
  // ── 1. Default HLOne ──
  {
    id: "default",
    name: "Default HLOne",
    tagline: "Everything we built",
    description: "The full HLOne experience — all panels on. Great starting point to see what's available.",
    config: {
      version: STUDIO_CONFIG_VERSION,
      slug: "my-hlone",
      name: "My HLOne",
      tagline: "The HyperLiquid trading terminal",
      widgets: widgetsFrom([
        "tickerBar", "priceChart", "tradingPanel", "orderBook", "positionsPanel", "marketPulse",
        "sharpFlowTable", "whaleFeed", "whaleAccumulation", "signalsPanel", "divergencePanel",
        "deriveOptions", "copyTradePanel",
      ]),
      defaultToken: "BTC",
      watchlist: ["BTC", "ETH", "HYPE", "SOL"],
      branding: { accentColor: "#98fce4" },
      fees: { builderWallet: "0x0000000000000000000000000000000000000000", markupBps: 0 },
      theme: "dark",
    },
  },

  // ── 2. Whale Hunter ──
  {
    id: "whale-hunter",
    name: "Whale Hunter",
    tagline: "Follow the smart money",
    description: "Whale feed, accumulation tracker, and large trade tape front-and-center. Minimal distraction, max signal.",
    config: {
      version: STUDIO_CONFIG_VERSION,
      slug: "whale-hunter",
      name: "Whale Hunter",
      tagline: "Follow the smart money",
      widgets: widgetsFrom([
        "tickerBar", "priceChart", "tradingPanel", "positionsPanel",
        "whaleFeed", "whaleAccumulation", "largeTradeTape", "positionConcentration",
        "sharpFlowTable",
      ]),
      defaultToken: "BTC",
      watchlist: ["BTC", "ETH", "HYPE", "SOL"],
      branding: { accentColor: "#ff6b00" },
      fees: { builderWallet: "0x0000000000000000000000000000000000000000", markupBps: 10 },
      theme: "dark",
    },
  },

  // ── 3. Scalper Pro ──
  {
    id: "scalper-pro",
    name: "Scalper Pro",
    tagline: "Fast execution, tight focus",
    description: "Order book, trading panel, positions, and live signals. No noise. Built for speed.",
    config: {
      version: STUDIO_CONFIG_VERSION,
      slug: "scalper-pro",
      name: "Scalper Pro",
      tagline: "Fast execution, tight focus",
      widgets: widgetsFrom([
        "tickerBar", "priceChart", "tradingPanel", "orderBook", "positionsPanel",
        "signalsPanel", "largeTradeTape", "marketPulse",
      ]),
      defaultToken: "BTC",
      watchlist: ["BTC", "ETH", "HYPE"],
      branding: { accentColor: "#00ff88" },
      fees: { builderWallet: "0x0000000000000000000000000000000000000000", markupBps: 5 },
      theme: "dark",
    },
  },

  // ── 4. Options Focus ──
  {
    id: "options-focus",
    name: "Options Focus",
    tagline: "Calls, puts, Greeks",
    description: "Derive options chain front and center with Deribit flow for comparison. Vol regime + IV rank always visible.",
    config: {
      version: STUDIO_CONFIG_VERSION,
      slug: "options-focus",
      name: "Options Focus",
      tagline: "Calls, puts, Greeks",
      widgets: widgetsFrom([
        "tickerBar", "priceChart", "marketPulse",
        "deriveOptions", "deribitFlow",
        "positionsPanel", "whaleFeed",
      ]),
      defaultToken: "HYPE",
      watchlist: ["HYPE", "BTC", "ETH", "SOL"],
      branding: { accentColor: "#a855f7" },
      fees: { builderWallet: "0x0000000000000000000000000000000000000000", markupBps: 15 },
      theme: "dark",
    },
  },

  // ── 5. Minimalist ──
  {
    id: "minimalist",
    name: "Minimalist",
    tagline: "Chart. Trade. Done.",
    description: "Just the essentials — chart, one-click trade, positions. For traders who want a clean, uncluttered interface.",
    config: {
      version: STUDIO_CONFIG_VERSION,
      slug: "minimalist",
      name: "Minimalist",
      tagline: "Chart. Trade. Done.",
      widgets: widgetsFrom([
        "tickerBar", "priceChart", "tradingPanel", "positionsPanel",
      ]),
      defaultToken: "BTC",
      watchlist: ["BTC", "ETH", "HYPE"],
      branding: { accentColor: "#ffffff" },
      fees: { builderWallet: "0x0000000000000000000000000000000000000000", markupBps: 0 },
      theme: "dark",
    },
  },
];

export function getTemplate(id: string): StudioTemplate | undefined {
  return STUDIO_TEMPLATES.find(t => t.id === id);
}
