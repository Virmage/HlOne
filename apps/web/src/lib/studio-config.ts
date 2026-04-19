/**
 * HLOne Studio — Configuration schema for config-driven terminal builds.
 *
 * A StudioConfig fully describes a custom HLOne instance:
 *   - Which widgets are visible
 *   - Layout preferences
 *   - Branding (name, color, logo)
 *   - Default token + watchlist
 *   - Builder fee wallet + markup
 *
 * This config is:
 *   - Saved to `studio.config.json` at the root of a forked repo
 *   - Loaded at runtime by the terminal page
 *   - Editable via the Studio UI at /studio
 */

export const STUDIO_CONFIG_VERSION = 1 as const;

// ─── Widget catalog ─────────────────────────────────────────────────────────
// Every toggleable widget in HLOne. Add new widgets here to expose them in Studio.
export const WIDGET_KEYS = [
  // Core (recommended always-on)
  "tickerBar",
  "priceChart",
  "tradingPanel",
  "orderBook",
  "positionsPanel",
  "marketPulse",

  // Flow / signals
  "sharpFlowTable",
  "whaleFeed",
  "whaleAccumulation",
  "largeTradeTape",
  "signalsPanel",
  "divergencePanel",
  "positionConcentration",

  // Market data
  "fundingLeaderboard",
  "lendingRates",
  "socialPanel",
  "newsFeed",

  // Derivatives
  "deribitFlow",
  "deriveOptions",

  // Ecosystem
  "ecosystemPanel",
  "copyTradePanel",
] as const;

export type WidgetKey = (typeof WIDGET_KEYS)[number];

export interface WidgetMeta {
  key: WidgetKey;
  label: string;
  description: string;
  category: "core" | "flow" | "market" | "derivatives" | "ecosystem";
  /** Rough size hint for preview layout */
  size: "small" | "medium" | "large";
  /** Default on-state in most templates */
  defaultOn: boolean;
}

export const WIDGET_CATALOG: WidgetMeta[] = [
  { key: "tickerBar",              label: "Ticker Bar",              category: "core",        size: "small",  defaultOn: true,  description: "Scrolling top-coins price ticker with sharp-flow signals" },
  { key: "priceChart",             label: "Price Chart",             category: "core",        size: "large",  defaultOn: true,  description: "TradingView chart with whale/sharp entry markers" },
  { key: "tradingPanel",           label: "Trading Panel",           category: "core",        size: "medium", defaultOn: true,  description: "One-click order entry for perps + options" },
  { key: "orderBook",              label: "Order Book",              category: "core",        size: "medium", defaultOn: true,  description: "Live L2 order book depth" },
  { key: "positionsPanel",         label: "Positions & Orders",      category: "core",        size: "medium", defaultOn: true,  description: "Open positions, orders, fills, PnL" },
  { key: "marketPulse",            label: "Market Pulse",            category: "core",        size: "small",  defaultOn: true,  description: "BTC/ETH/HYPE macro regime + vol state" },
  { key: "sharpFlowTable",         label: "Sharp Flow",              category: "flow",        size: "medium", defaultOn: true,  description: "Tokens ranked by smart-money conviction" },
  { key: "whaleFeed",              label: "Whale Feed",              category: "flow",        size: "medium", defaultOn: true,  description: "Live position changes from top-200 accounts" },
  { key: "whaleAccumulation",      label: "Whale Accumulation",      category: "flow",        size: "medium", defaultOn: true,  description: "Net whale positioning over 1h/24h/7d per coin" },
  { key: "largeTradeTape",         label: "Large Trade Tape",        category: "flow",        size: "medium", defaultOn: false, description: "Real-time tape of large ($100K+) fills" },
  { key: "signalsPanel",           label: "Signals",                 category: "flow",        size: "medium", defaultOn: true,  description: "Curated entry/exit signals from sharp + whale data" },
  { key: "divergencePanel",        label: "Divergences",             category: "flow",        size: "medium", defaultOn: true,  description: "Where sharp + square money disagree (highest edge)" },
  { key: "positionConcentration",  label: "Position Concentration",  category: "flow",        size: "small",  defaultOn: false, description: "How concentrated positioning is in top accounts" },
  { key: "fundingLeaderboard",     label: "Funding Leaderboard",     category: "market",      size: "medium", defaultOn: false, description: "Highest/lowest funding rates across HL" },
  { key: "lendingRates",           label: "Lending Rates",           category: "market",      size: "small",  defaultOn: false, description: "HLP + lending rate snapshot" },
  { key: "socialPanel",            label: "Social Pulse",            category: "market",      size: "medium", defaultOn: false, description: "LunarCrush galaxy score + social volume" },
  { key: "newsFeed",               label: "News Feed",               category: "market",      size: "medium", defaultOn: false, description: "Aggregated crypto news + X highlights" },
  { key: "deribitFlow",            label: "Deribit Flow",            category: "derivatives", size: "medium", defaultOn: false, description: "Deribit options flow (major player activity)" },
  { key: "deriveOptions",          label: "Derive Options",          category: "derivatives", size: "large",  defaultOn: false, description: "Derive options chain for HYPE + majors" },
  { key: "ecosystemPanel",         label: "Ecosystem",               category: "ecosystem",   size: "medium", defaultOn: false, description: "HyperLiquid ecosystem token tracker" },
  { key: "copyTradePanel",         label: "Copy Trade",              category: "ecosystem",   size: "medium", defaultOn: false, description: "One-click copy top traders" },
];

// ─── Full config shape ─────────────────────────────────────────────────────
export interface StudioConfig {
  version: typeof STUDIO_CONFIG_VERSION;

  /** Unique slug for this build (lowercase, alphanumeric + dash). Used in URL. */
  slug: string;

  /** Display name ("SwiftWhale Terminal", "MyScalper", etc.) */
  name: string;

  /** One-line tagline shown in header + discover page */
  tagline?: string;

  /** Which widgets are enabled (subset of WIDGET_KEYS) */
  widgets: Partial<Record<WidgetKey, boolean>>;

  /** Widget display order (left-to-right, top-to-bottom) — overrides defaults when set */
  widgetOrder?: WidgetKey[];

  /** Default token selected on page load (e.g. "BTC", "ETH", "HYPE") */
  defaultToken: string;

  /** Watchlist shown in ticker bar + token quick-switcher */
  watchlist: string[];

  branding: {
    /** Single accent color, HSL or hex */
    accentColor: string;
    /** Logo URL (optional) — displayed in header */
    logoUrl?: string;
    /** Twitter / X handle for header link */
    twitter?: string;
    /** Discord invite URL */
    discord?: string;
    /** Site URL (for SEO + og:url) */
    siteUrl?: string;
  };

  /**
   * Fee config.
   *
   * DESIGN DECISION: Studio deploys route 100% of the builder fee to HLOne.
   * Builders do NOT earn trade fees. They pay $50 once for the deploy.
   *
   * This is because HL only supports ONE builder per order — so we can't stack
   * fees natively. Rather than build a sweeper to redistribute, we keep things
   * simple: HL takes their cut, HLOne takes a small cut, that's it. Builders
   * build for themselves (or for audiences who don't care about ref fees).
   *
   * If/when builder-earn-fees becomes a feature, we'll add `markupBps` here
   * and build a sweeper cron job. Not today.
   */
  fees?: {
    /** Reserved for future builder-earns-fee feature. Always 0 for now. */
    markupBps?: number;
    /** Reserved for future: builder's payout wallet. */
    builderWallet?: `0x${string}`;
  };

  /** Theme */
  theme?: "dark" | "light" | "auto";

  /** Internal: created timestamp, last updated timestamp */
  meta?: {
    createdAt?: string;
    updatedAt?: string;
    /** HLOne Studio deploy ID (used for API key lookup) */
    deployId?: string;
  };
}

// ─── Defaults + validation ─────────────────────────────────────────────────
export const DEFAULT_CONFIG: StudioConfig = {
  version: STUDIO_CONFIG_VERSION,
  slug: "hlone",
  name: "HLOne",
  tagline: "The HyperLiquid trading terminal",
  widgets: Object.fromEntries(WIDGET_CATALOG.map(w => [w.key, w.defaultOn])) as Record<WidgetKey, boolean>,
  defaultToken: "BTC",
  watchlist: ["BTC", "ETH", "HYPE", "SOL"],
  branding: {
    accentColor: "#98fce4", // HL teal
  },
  fees: {},
  theme: "dark",
};

/** HLOne's platform fee — hardcoded in hl-exchange.ts, shown here for UI display only */
export const HLONE_PLATFORM_FEE_BPS = 1.5; // 0.015% — matches BUILDER_FEE=15 in hl-exchange.ts
export const MAX_MARKUP_BPS = 40; // reserved for future

export function isWidgetEnabled(config: StudioConfig, key: WidgetKey): boolean {
  const v = config.widgets[key];
  if (v !== undefined) return v;
  // Fall back to catalog default if not explicitly set
  return WIDGET_CATALOG.find(w => w.key === key)?.defaultOn ?? false;
}

export function validateConfig(config: Partial<StudioConfig>): { ok: true; config: StudioConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!config.slug || !/^[a-z0-9-]{2,32}$/.test(config.slug)) {
    errors.push("Slug must be 2-32 chars, lowercase letters/numbers/dashes only");
  }
  if (!config.name || config.name.length < 2 || config.name.length > 40) {
    errors.push("Name must be 2-40 characters");
  }
  if (!config.defaultToken || !/^[A-Z0-9]{2,10}$/.test(config.defaultToken)) {
    errors.push("Default token must be 2-10 uppercase letters/numbers (e.g. BTC, HYPE)");
  }
  if (!config.watchlist || config.watchlist.length === 0) {
    errors.push("Watchlist must contain at least one token");
  }
  if (config.branding?.accentColor && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(config.branding.accentColor)) {
    errors.push("Accent color must be a valid hex (#fff or #ffffff)");
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { ...DEFAULT_CONFIG, ...config } as StudioConfig };
}
