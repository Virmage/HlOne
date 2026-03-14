/**
 * Trader Ranking Engine
 *
 * Scoring weights from the plan:
 * - 30% risk-adjusted return (Sharpe-like ratio)
 * - 20% absolute PnL
 * - 15% ROI
 * - 15% consistency (std dev of daily returns, inverted)
 * - 10% drawdown penalty
 * - 10% recency / activity
 */

export interface TraderStats {
  address: string;
  totalPnl: number;
  roiPercent: number;
  accountSize: number;
  maxDrawdownPercent: number;
  winRate: number;
  tradeCount: number;
  dailyReturns: number[]; // for consistency calc
  lastActiveAt: Date;
  maxLeverage: number;
}

export interface TraderScore {
  address: string;
  riskAdjustedReturn: number;
  absolutePnlScore: number;
  roiScore: number;
  consistencyScore: number;
  drawdownPenalty: number;
  recencyScore: number;
  compositeScore: number;
}

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1));
}

export function computeScores(traders: TraderStats[]): TraderScore[] {
  if (traders.length === 0) return [];

  // Compute raw metrics
  const rawScores = traders.map((t) => {
    const dailyStd = standardDeviation(t.dailyReturns);
    const meanReturn =
      t.dailyReturns.length > 0
        ? t.dailyReturns.reduce((a, b) => a + b, 0) / t.dailyReturns.length
        : 0;

    // Sharpe-like: mean daily return / std dev
    const sharpe = dailyStd > 0 ? meanReturn / dailyStd : 0;

    // Recency: days since last active, decay over 30 days
    const daysSinceActive =
      (Date.now() - t.lastActiveAt.getTime()) / (1000 * 60 * 60 * 24);
    const recency = Math.max(0, 1 - daysSinceActive / 30);

    return {
      address: t.address,
      sharpe,
      absolutePnl: t.totalPnl,
      roi: t.roiPercent,
      consistency: dailyStd > 0 ? 1 / dailyStd : 1, // Lower vol = higher score
      drawdown: t.maxDrawdownPercent,
      recency,
    };
  });

  // Get ranges for normalization
  const sharpes = rawScores.map((r) => r.sharpe);
  const pnls = rawScores.map((r) => r.absolutePnl);
  const rois = rawScores.map((r) => r.roi);
  const consistencies = rawScores.map((r) => r.consistency);
  const drawdowns = rawScores.map((r) => r.drawdown);

  const range = (arr: number[]) => ({
    min: Math.min(...arr),
    max: Math.max(...arr),
  });

  const sharpeRange = range(sharpes);
  const pnlRange = range(pnls);
  const roiRange = range(rois);
  const consistencyRange = range(consistencies);
  const drawdownRange = range(drawdowns);

  return rawScores
    .map((r) => {
      const riskAdjustedReturn = normalize(r.sharpe, sharpeRange.min, sharpeRange.max);
      const absolutePnlScore = normalize(r.absolutePnl, pnlRange.min, pnlRange.max);
      const roiScore = normalize(r.roi, roiRange.min, roiRange.max);
      const consistencyScore = normalize(
        r.consistency,
        consistencyRange.min,
        consistencyRange.max
      );
      // Drawdown is a penalty — higher drawdown = lower score
      const drawdownPenalty =
        1 - normalize(r.drawdown, drawdownRange.min, drawdownRange.max);
      const recencyScore = r.recency;

      const compositeScore =
        0.3 * riskAdjustedReturn +
        0.2 * absolutePnlScore +
        0.15 * roiScore +
        0.15 * consistencyScore +
        0.1 * drawdownPenalty +
        0.1 * recencyScore;

      return {
        address: r.address,
        riskAdjustedReturn,
        absolutePnlScore,
        roiScore,
        consistencyScore,
        drawdownPenalty,
        recencyScore,
        compositeScore,
      };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);
}
