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
