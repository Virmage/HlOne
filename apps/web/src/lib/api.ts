// In production, use relative URLs (proxied through Next.js rewrites)
// In development, hit the API directly
const API_URL = typeof window !== "undefined" && process.env.NODE_ENV === "production"
  ? ""  // Relative — proxied via next.config rewrites
  : (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001");

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt)); // backoff
      const res = await fetch(`${API_URL}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) continue;
    }
  }

  throw lastError!;
}

// ─── Traders ─────────────────────────────────────────────────────────────────

export interface TraderRow {
  id: string;
  address: string;
  displayName: string | null;
  isSharp?: boolean;
  accountSize: string | null;
  totalPnl: string | null;
  roiPercent: number | null;
  roi30d: number | null;
  roiWeekly: number | null;
  pnl30d: string | null;
  winRate: number | null;
  tradeCount: number | null;
  maxLeverage: number | null;
  maxDrawdown: number | null;
  lastActiveAt: string | null;
  compositeScore: number | null;
  rank: number | null;
}

export interface TraderFilters {
  minAccountSize?: string;
  minRoi?: string;
  minPnl?: string;
  minTrades?: string;
  maxLeverage?: string;
  sortBy?: string;
  order?: "asc" | "desc";
  limit?: string;
  offset?: string;
}

export async function getTraders(filters: TraderFilters = {}) {
  const params = new URLSearchParams();
  for (const [key, val] of Object.entries(filters)) {
    if (val !== undefined && val !== "") params.set(key, val);
  }
  return apiFetch<{ traders: TraderRow[]; total: number }>(
    `/api/traders?${params}`
  );
}

export interface TraderDetail {
  profile: TraderRow | null;
  live: {
    clearinghouse: Record<string, unknown> | null;
    portfolio: Record<string, unknown> | null;
    recentFills: Record<string, unknown>[];
  };
  positions: {
    id: string;
    asset: string;
    side: string;
    size: string;
    entryPrice: string;
    leverage: number | null;
    unrealizedPnl: string | null;
  }[];
  equityCurve: {
    time: string;
    value: string | null;
    pnl: string | null;
    drawdown: number | null;
  }[];
}

export async function getTraderDetail(address: string) {
  return apiFetch<TraderDetail>(`/api/traders/${address}`);
}

// ─── Portfolio ───────────────────────────────────────────────────────────────

export interface PortfolioOverview {
  walletBalance: number;
  availableMargin: number;
  allocatedCapital: number;
  unrealizedPnl: number;
  realizedPnl: number;
  idleCapital: number;
}

export interface CopiedTrader {
  id: string;
  isActive: boolean;
  isPaused: boolean;
  traderAddress: string | null;
  traderPnl: string | null;
  traderRoi: number | null;
  allocatedCapital: string | null;
  maxLeverage: number | null;
  maxPositionSizePercent: number | null;
  currentExposure: number;
  pnlContribution: number;
  positionCount: number;
}

export interface OpenPosition {
  id: string;
  asset: string;
  side: string;
  size: string;
  entryPrice: string;
  currentPrice: string | null;
  unrealizedPnl: string | null;
  realizedPnl: string | null;
  openedAt: string;
  traderAddress: string | null;
  copyRelationshipId: string;
}

export interface PortfolioData {
  overview: PortfolioOverview | null;
  copiedTraders: CopiedTrader[];
  openPositions: OpenPosition[];
  suggestions: string[];
}

export async function getPortfolio(walletAddress: string) {
  return apiFetch<PortfolioData>(`/api/portfolio/${walletAddress}`);
}

export async function getPortfolioHistory(walletAddress: string, days = 30) {
  return apiFetch<{ snapshots: Record<string, unknown>[] }>(
    `/api/portfolio/${walletAddress}/history?days=${days}`
  );
}

// ─── Copy ────────────────────────────────────────────────────────────────────

export async function startCopy(data: {
  walletAddress: string;
  traderAddress: string;
  allocatedCapital: number;
  maxLeverage?: number;
  maxPositionSizePercent?: number;
  minOrderSize?: number;
}) {
  return apiFetch<{ id: string; status: string }>("/api/copy/start", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function stopCopy(walletAddress: string, traderAddress: string) {
  return apiFetch<{ status: string }>("/api/copy/stop", {
    method: "POST",
    body: JSON.stringify({ walletAddress, traderAddress }),
  });
}

export async function pauseCopy(copyRelationshipId: string, paused: boolean) {
  return apiFetch<{ status: string }>("/api/copy/pause", {
    method: "POST",
    body: JSON.stringify({ copyRelationshipId, paused }),
  });
}

export async function updateAllocation(data: {
  copyRelationshipId: string;
  allocatedCapital?: number;
  maxLeverage?: number;
  maxPositionSizePercent?: number;
  minOrderSize?: number;
}) {
  return apiFetch<{ status: string }>("/api/copy/allocation", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function closePosition(positionId: string, reason?: string) {
  return apiFetch<{ status: string }>("/api/copy/close-position", {
    method: "POST",
    body: JSON.stringify({ positionId, reason }),
  });
}

// ─── Builder Fee ────────────────────────────────────────────────────────────

export interface BuilderFeeInfo {
  builder: string;
  fee: number;
  feePercent: string;
  feeDisplay: string;
}

export async function getBuilderFee() {
  return apiFetch<BuilderFeeInfo>("/api/copy/builder-fee");
}

export async function checkBuilderApproval(userAddress: string) {
  return apiFetch<{ approved: boolean; maxFee: number }>(
    `/api/copy/check-builder-approval?user=${userAddress}`
  );
}

// ─── Market Terminal ─────────────────────────────────────────────────────────

export interface TokenOverview {
  coin: string;
  displayName?: string; // resolved name for spot tokens (e.g. "HYPE" instead of "@109")
  price: number;
  prevDayPx: number;
  change24h: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  markPx: number;
  oraclePx: number;
  premium: number;
  maxLeverage: number;
  score: HLOneScore | null;
  isSpot?: boolean;
  dex?: string;       // HIP-3 builder dex (xyz, flx, etc.)
  category?: string;  // stocks, indices, commodities, fx, pre-ipo, sectors
}

export interface HLOneScore {
  coin: string;
  score: number;
  signal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  breakdown: {
    sharpConviction: number;
    whaleAccumulation: number;
    priceTrend: number;
    fundingRegime: number;
    socialMomentum: number;
  };
  sharpDirection: "long" | "short" | "neutral";
  sharpCount: number;
  divergence: boolean;
}

export interface SharpFlow {
  coin: string;
  sharpLongCount: number;
  sharpShortCount: number;
  sharpNetSize: number;
  sharpStrength: number;
  sharpDirection: string;
  squareLongCount: number;
  squareShortCount: number;
  squareNetSize: number;
  squareStrength: number;
  squareDirection: string;
  consensus: string;
  divergence: boolean;
  divergenceScore: number;
  score: number | null;
  signal: string;
  price: number;
  change24h: number;
  volume24h: number;
  fundingRate: number;
}

export interface WhaleAlert {
  id: string;
  whaleAddress: string;
  whaleName: string;
  accountValue: number;
  coin: string;
  eventType: string;
  oldSize: number;
  newSize: number;
  positionValueUsd: number;
  price: number;
  detectedAt: number;
}

export interface DivergenceSignal {
  coin: string;
  sharpDirection: string;
  squareDirection: string;
  sharpCount: number;
  squareCount: number;
  sharpConviction: number;
  description: string;
  score: number | null;
  price: number;
  change24h: number;
}

export interface TopTrader {
  address: string;
  displayName: string;
  accountValue: number;
  roi30d: number;
  roiAllTime: number;
  totalPnl: number;
  isSharp: boolean;
}

export interface OptionsSnapshot {
  currency: string;
  maxPain: number;
  maxPainExpiry: string;
  maxPainDistance: number;
  putCallRatio: number;
  totalCallOI: number;
  totalPutOI: number;
  dvol: number;
  ivRank: number;
  skew25d: number;
  gex: number;
  gexLevel: "dampening" | "amplifying" | "neutral";
  topStrikes: { strike: number; callOI: number; putOI: number }[];
}

export interface HypeOptionRow {
  instrument: string;
  expiry: string;
  expiryTimestamp: number;
  strike: number;
  type: "C" | "P";
  markPrice: number;
  bidPrice: number;
  askPrice: number;
  bidAmount: number;
  askAmount: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  openInterest: number;
  volume24h: number;
}

export interface DeriveOptionsChain {
  coin: string;
  chain: HypeOptionRow[];
  spotPrice: number;
  expiries: { label: string; timestamp: number }[];
  summary: {
    maxPain: number;
    maxPainExpiry: string;
    maxPainDistance: number;
    putCallRatio: number;
    totalCallOI: number;
    totalPutOI: number;
    iv: number;
    ivRank: number;
    skew25d: number;
    gex: number;
    gexLevel: "dampening" | "amplifying" | "neutral";
    totalVolume24h: number;
  } | null;
  source: "derive";
  timestamp: number;
}

// Keep backward compat alias
export type HypeOptionsChain = DeriveOptionsChain;

export interface TradingSignal {
  type: string;
  coin: string;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  value: number;
}

export interface FundingOpportunity {
  coin: string;
  fundingRate: number;
  annualizedPct: number;
  direction: "long" | "short";
  description: string;
}

export interface MarketRegime {
  regime: "risk_on" | "risk_off" | "chop" | "rotation" | "squeeze" | "capitulation";
  action: string;
  description: string;
  confidence: number;
  bullishCount: number;
  bearishCount: number;
  avgChange24h: number;
}

export interface NewsPost {
  id: number;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  currencies: string[];
  sentiment: "positive" | "negative" | "neutral";
  votes: { positive: number; negative: number; important: number; liked: number; toxic: number };
}

export interface SocialMetrics {
  coin: string;
  galaxyScore: number;
  altRank: number;
  socialVolume: number;
  socialDominance: number;
  sentiment: number;
  socialEngagement: number;
  socialContributors: number;
  trendingScore: number;
}

export interface SharpSquareCallout {
  sharpTopLong: { coin: string; count: number; pct: number } | null;
  sharpTopShort: { coin: string; count: number; pct: number } | null;
  squareTopLong: { coin: string; count: number; pct: number } | null;
  squareTopShort: { coin: string; count: number; pct: number } | null;
}

export interface FundingLeaderboard {
  topPositive: { coin: string; fundingRate: number; annualized: number; openInterest: number }[];
  topNegative: { coin: string; fundingRate: number; annualized: number; openInterest: number }[];
}

export interface LargeTrade {
  coin: string;
  side: "buy" | "sell";
  sizeUsd: number;
  sizeNative: number;
  price: number;
  time: number;
  hash: string;
  taker: string;
}

export interface MacroAsset {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  prevClose: number;
}

// ─── Liquidation Heatmap ─────────────────────────────────────────────────────

export interface LiquidationBand {
  priceLow: number;
  priceHigh: number;
  priceMid: number;
  longLiqValue: number;
  shortLiqValue: number;
  traderCount: number;
  distancePct: number;
}

export interface LiquidationHeatmap {
  coin: string;
  currentPrice: number;
  bands: LiquidationBand[];
  totalLongLiqAbove: number;
  totalShortLiqBelow: number;
}

// ─── Correlation Matrix ─────────────────────────────────────────────────────

export interface CorrelationMatrix {
  coins: string[];
  matrix: number[][];
  avgCorrelation: number;
  outliers: {
    coin1: string;
    coin2: string;
    correlation: number;
    label: "highly_correlated" | "decorrelated" | "inversely_correlated";
  }[];
}

// ─── Order Flow ─────────────────────────────────────────────────────────────

export interface OrderFlowWindow {
  interval: "1m" | "5m" | "15m";
  buyVolume: number;
  sellVolume: number;
  netFlow: number;
  imbalance: number;
  buyCount: number;
  sellCount: number;
}

export interface OrderFlowCoin {
  coin: string;
  currentPrice: number;
  windows: OrderFlowWindow[];
  delta5m: number;
}

// ─── Position Concentration ─────────────────────────────────────────────────

export interface TopHolder {
  displayName: string;
  side: "long" | "short";
  positionValue: number;
  leverage: number;
  pctOfOI: number;
}

export interface PositionConcentration {
  coin: string;
  totalOI: number;
  trackedOI: number;
  trackedPct: number;
  top5Value: number;
  top5Pct: number;
  top10Value: number;
  top10Pct: number;
  herfindahl: number;
  longPct: number;
  isCrowded: boolean;
  topHolders: TopHolder[];
}

export interface TerminalData {
  tokens: TokenOverview[];
  sharpFlow: SharpFlow[];
  divergences: DivergenceSignal[];
  whaleAlerts: WhaleAlert[];
  hotTokens: { coin: string; eventCount: number }[];
  topTraders: TopTrader[];
  options: Record<string, OptionsSnapshot>;
  signals: TradingSignal[];
  fundingOpps: FundingOpportunity[];
  regime: MarketRegime | null;
  callout: SharpSquareCallout | null;
  news: NewsPost[];
  social: SocialMetrics[];
  funding: FundingLeaderboard;
  largeTrades: LargeTrade[];
  macro: MacroAsset[];
  liquidationHeatmap: LiquidationHeatmap[];
  correlationMatrix: CorrelationMatrix | null;
  orderFlow: OrderFlowCoin[];
  positionConcentration: PositionConcentration[];
  timestamp: number;
}

export interface TraderPosition {
  address: string;
  displayName: string;
  isSharp: boolean;
  accountValue: number;
  roiAllTime: number;
  coin: string;
  side: "long" | "short";
  size: number;
  entryPx: number;
  positionValue: number;
  leverage: number;
  unrealizedPnl: number;
  liquidationPx: number | null;
}

export interface BookWall {
  side: "bid" | "ask";
  price: number;
  size: number;
  multiplier: number;
}

export interface TokenDetail {
  coin: string;
  overview: TokenOverview | null;
  score: HLOneScore | null;
  sharpPositions: TraderPosition[];
  bookAnalysis: {
    coin: string;
    bidDepth: number;
    askDepth: number;
    imbalance: number;
    spread: number;
    spreadBps: number;
    walls: BookWall[];
  } | null;
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  oiCandles: { time: number; open: number; high: number; low: number; close: number }[];
  funding: { time: number; rate: number; annualized: number }[];
  fundingRegime: string;
  liquidationClusters: { price: number; side: string; totalValue: number; traderCount: number }[];
  whaleAlerts: WhaleAlert[];
  topTraderFills: { time: number; side: "buy" | "sell"; price: number; sizeUsd: number; trader: string }[];
  options: OptionsSnapshot | null;
  news: NewsPost[];
  social: SocialMetrics | null;
  timestamp: number;
}

// ─── Request cache + dedup ─────────────────────────────────────────────────
// Prevents duplicate in-flight requests and caches recent results

const requestCache = new Map<string, { data: unknown; time: number }>();
const inflightRequests = new Map<string, Promise<unknown>>();

function cachedFetch<T>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<T> {
  // Return cached if fresh
  const cached = requestCache.get(key);
  if (cached && Date.now() - cached.time < ttlMs) {
    return Promise.resolve(cached.data as T);
  }
  // Dedup in-flight requests
  const inflight = inflightRequests.get(key);
  if (inflight) return inflight as Promise<T>;

  const promise = fetcher().then(data => {
    requestCache.set(key, { data, time: Date.now() });
    inflightRequests.delete(key);
    return data;
  }).catch(err => {
    inflightRequests.delete(key);
    // Return stale cache on error if available
    if (cached) return cached.data as T;
    throw err;
  });
  inflightRequests.set(key, promise);
  return promise;
}

export async function getTerminalData() {
  return cachedFetch("terminal", () => apiFetch<TerminalData>("/api/market/terminal"), 10_000);
}

export async function getTokenDetail(coin: string, interval = "1h") {
  const key = `detail:${coin}:${interval}`;
  return cachedFetch(key, () => apiFetch<TokenDetail>(`/api/market/token/${encodeURIComponent(coin)}?interval=${interval}`), 5_000);
}

export async function getDeriveOptionsChain(coin: string) {
  const key = `options:${coin}`;
  return cachedFetch(key, () => apiFetch<DeriveOptionsChain>(`/api/market/options/${encodeURIComponent(coin)}`), 15_000);
}

// Backward compat
export const getHypeOptionsChain = () => getDeriveOptionsChain("HYPE");

export async function getWhaleAlertsFeed(limit = 50, coin?: string) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (coin) params.set("coin", coin);
  return apiFetch<{ alerts: WhaleAlert[]; hotTokens: { coin: string; eventCount: number }[] }>(
    `/api/market/whale-alerts?${params}`
  );
}

// ─── User Positions ─────────────────────────────────────────────────────────

export interface UserPosition {
  coin: string;
  side: "long" | "short";
  size: number;
  entryPx: number;
  markPx: number;
  positionValue: number;
  unrealizedPnl: number;
  leverage: number;
  leverageType: "cross" | "isolated";
  liquidationPx: number | null;
  marginUsed: number;
  returnOnEquity: number;
  cumFunding: number;
}

export interface UserAccount {
  accountValue: number;
  totalMarginUsed: number;
  totalNotional: number;
  withdrawable: number;
}

export interface UserPositionsData {
  positions: UserPosition[];
  account: UserAccount | null;
  openOrders: { coin: string; side: string; sz: string; limitPx: string; orderType: string }[];
  triggerOrders?: Record<string, { tp?: string; sl?: string }>;
  timestamp: number;
}

export async function getUserPositions(address: string) {
  return apiFetch<UserPositionsData>(`/api/market/positions/${address}`);
}

// ─── Users ───────────────────────────────────────────────────────────────────

export async function connectUser(walletAddress: string) {
  return apiFetch<{
    user: { id: string; walletAddress: string; createdAt: string };
    hasApiWallet: boolean;
    apiWalletExpiry: string | null;
  }>("/api/users/connect", {
    method: "POST",
    body: JSON.stringify({ walletAddress }),
  });
}
