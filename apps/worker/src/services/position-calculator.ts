/**
 * Position Calculator
 *
 * Determines what size to trade for a follower based on:
 * - Source trader's fill (asset, size, direction)
 * - Follower's allocation settings (capital, max leverage, max position %)
 * - Source trader's account size (for proportional sizing)
 *
 * Risk controls enforced here:
 * - Max leverage cap
 * - Max position size as % of allocation
 * - Minimum order threshold
 * - Skip if insufficient margin
 */

export interface FillEvent {
  coin: string;
  px: string;       // execution price
  sz: string;       // size
  side: string;     // "A" (ask/sell) or "B" (bid/buy)
  dir: string;      // "Open Long", "Close Long", "Open Short", "Close Short"
  closedPnl: string;
  time: number;
  hash: string;
}

export interface AllocationSettings {
  allocatedCapital: number;
  maxLeverage: number;
  maxPositionSizePercent: number;
  minOrderSize: number;
}

export interface CalculatedOrder {
  asset: string;
  isBuy: boolean;
  size: number;
  reduceOnly: boolean;
  direction: string;
}

export interface SkipReason {
  skipped: true;
  reason: string;
}

export type CalculationResult = CalculatedOrder | SkipReason;

export function isSkipped(result: CalculationResult): result is SkipReason {
  return "skipped" in result;
}

export function calculateFollowerOrder(
  fill: FillEvent,
  allocation: AllocationSettings,
  sourceAccountSize: number,
  followerAvailableMargin: number
): CalculationResult {
  const sourceSize = parseFloat(fill.sz);
  const price = parseFloat(fill.px);
  const sourceNotional = sourceSize * price;

  if (sourceSize === 0 || price === 0) {
    return { skipped: true, reason: "Zero size or price in fill" };
  }

  // ─── Proportional sizing ───────────────────────────────────────────
  // Ratio = follower allocation / source account size
  // Follower size = source size * ratio
  const ratio = sourceAccountSize > 0
    ? allocation.allocatedCapital / sourceAccountSize
    : 0;

  if (ratio === 0) {
    return { skipped: true, reason: "Cannot calculate ratio (source account size unknown)" };
  }

  let followerSize = sourceSize * ratio;
  const followerNotional = followerSize * price;

  // ─── Risk controls ─────────────────────────────────────────────────

  // 1. Max position size check (% of allocated capital)
  const maxPositionNotional = allocation.allocatedCapital * (allocation.maxPositionSizePercent / 100);
  if (followerNotional > maxPositionNotional) {
    followerSize = maxPositionNotional / price;
  }

  // 2. Max leverage check
  const impliedLeverage = (followerSize * price) / allocation.allocatedCapital;
  if (impliedLeverage > allocation.maxLeverage) {
    followerSize = (allocation.allocatedCapital * allocation.maxLeverage) / price;
  }

  // 3. Minimum order size check
  const finalNotional = followerSize * price;
  if (finalNotional < allocation.minOrderSize) {
    return {
      skipped: true,
      reason: `Order notional $${finalNotional.toFixed(2)} below minimum $${allocation.minOrderSize}`,
    };
  }

  // 4. Margin check (only for opening trades)
  const isOpening = fill.dir.startsWith("Open");
  if (isOpening) {
    const requiredMargin = finalNotional / allocation.maxLeverage;
    if (requiredMargin > followerAvailableMargin) {
      return {
        skipped: true,
        reason: `Insufficient margin: need $${requiredMargin.toFixed(2)}, have $${followerAvailableMargin.toFixed(2)}`,
      };
    }
  }

  // ─── Determine direction ───────────────────────────────────────────
  const isBuy =
    fill.dir === "Open Long" || fill.dir === "Close Short";
  const reduceOnly =
    fill.dir === "Close Long" || fill.dir === "Close Short";

  // Round size to reasonable precision (5 significant figures)
  followerSize = parseFloat(followerSize.toPrecision(5));

  return {
    asset: fill.coin,
    isBuy,
    size: followerSize,
    reduceOnly,
    direction: fill.dir,
  };
}
