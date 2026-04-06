/**
 * Correlation Matrix — computes pairwise Pearson correlation of hourly returns
 * for top coins over the trailing 24 hours.
 */

import { getCandleSnapshot } from "./hyperliquid.js";
import { getCachedAssetCtxs } from "./market-data.js";

export interface CorrelationMatrix {
  coins: string[];
  matrix: number[][]; // NxN, values -1 to +1
  avgCorrelation: number;
  outliers: {
    coin1: string;
    coin2: string;
    correlation: number;
    label: "highly_correlated" | "decorrelated" | "inversely_correlated";
  }[];
}

let cached: CorrelationMatrix | null = null;
let lastComputed = 0;
const CACHE_TTL = 5 * 60_000; // 5 minutes

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

export async function computeCorrelationMatrix(): Promise<CorrelationMatrix | null> {
  try {
    const ctxs = await getCachedAssetCtxs();
    const topCoins = [...ctxs.entries()]
      .map(([coin, ctx]) => ({ coin, volume: parseFloat(ctx.dayNtlVlm || "0") }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10)
      .map(c => c.coin);

    if (topCoins.length < 3) return null;

    const now = Date.now();
    const since = now - 24 * 60 * 60_000;

    // Fetch 1h candles for all coins in parallel
    const candleResults = await Promise.all(
      topCoins.map(coin =>
        getCandleSnapshot(coin, "1h", since, now)
          .then(candles => ({ coin, candles }))
          .catch(() => ({ coin, candles: [] as { t: number; o: string; h: string; l: string; c: string; v: string }[] }))
      )
    );

    // Compute hourly returns
    const returns = new Map<string, number[]>();
    const validCoins: string[] = [];

    for (const { coin, candles } of candleResults) {
      if (candles.length < 6) continue;

      const hourlyReturns: number[] = [];
      for (let i = 1; i < candles.length; i++) {
        const prev = parseFloat(candles[i - 1].c);
        const curr = parseFloat(candles[i].c);
        if (prev > 0) {
          hourlyReturns.push((curr - prev) / prev);
        }
      }

      if (hourlyReturns.length >= 5) {
        returns.set(coin, hourlyReturns);
        validCoins.push(coin);
      }
    }

    if (validCoins.length < 3) return null;

    // Compute pairwise correlations
    const n = validCoins.length;
    const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    const outliers: CorrelationMatrix["outliers"] = [];
    let totalCorr = 0;
    let pairCount = 0;

    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1;
      const ri = returns.get(validCoins[i])!;

      for (let j = i + 1; j < n; j++) {
        const rj = returns.get(validCoins[j])!;
        const corr = Math.round(pearson(ri, rj) * 100) / 100;
        matrix[i][j] = corr;
        matrix[j][i] = corr;
        totalCorr += corr;
        pairCount++;

        // Flag outliers
        if (corr >= 0.85) {
          outliers.push({ coin1: validCoins[i], coin2: validCoins[j], correlation: corr, label: "highly_correlated" });
        } else if (corr <= -0.3) {
          outliers.push({ coin1: validCoins[i], coin2: validCoins[j], correlation: corr, label: "inversely_correlated" });
        } else if (Math.abs(corr) <= 0.15) {
          outliers.push({ coin1: validCoins[i], coin2: validCoins[j], correlation: corr, label: "decorrelated" });
        }
      }
    }

    // Sort outliers by extremity
    outliers.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    cached = {
      coins: validCoins,
      matrix,
      avgCorrelation: pairCount > 0 ? Math.round((totalCorr / pairCount) * 100) / 100 : 0,
      outliers: outliers.slice(0, 5),
    };
    lastComputed = Date.now();

    return cached;
  } catch (err) {
    console.error("[correlation] Compute failed:", (err as Error).message);
    return cached;
  }
}

export function getCorrelationMatrixCached(): CorrelationMatrix | null {
  return cached;
}
