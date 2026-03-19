// In production, use relative URLs (proxied through Next.js rewrites)
// In development, hit the API directly
const API_URL = typeof window !== "undefined" && process.env.NODE_ENV === "production"
  ? ""  // Relative — proxied via next.config rewrites
  : (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001");

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
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
  price: number;
  prevDayPx: number;
  change24h: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  markPx: number;
  oraclePx: number;
  premium: number;
  score: CpycatScore | null;
}

export interface CpycatScore {
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
  squareLongCount: number;
  squareShortCount: number;
  squareNetSize: number;
  consensus: string;
  divergence: boolean;
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

export interface TerminalData {
  tokens: TokenOverview[];
  sharpFlow: SharpFlow[];
  divergences: DivergenceSignal[];
  whaleAlerts: WhaleAlert[];
  hotTokens: { coin: string; eventCount: number }[];
  topTraders: TopTrader[];
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
  score: CpycatScore | null;
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
  funding: { time: number; rate: number; annualized: number }[];
  fundingRegime: string;
  liquidationClusters: { price: number; side: string; totalValue: number; traderCount: number }[];
  whaleAlerts: WhaleAlert[];
  timestamp: number;
}

export async function getTerminalData() {
  return apiFetch<TerminalData>("/api/market/terminal");
}

export async function getTokenDetail(coin: string, interval = "1h") {
  return apiFetch<TokenDetail>(`/api/market/token/${coin}?interval=${interval}`);
}

export async function getWhaleAlertsFeed(limit = 50, coin?: string) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (coin) params.set("coin", coin);
  return apiFetch<{ alerts: WhaleAlert[]; hotTokens: { coin: string; eventCount: number }[] }>(
    `/api/market/whale-alerts?${params}`
  );
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
