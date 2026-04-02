"use client";

import { useState, useCallback } from "react";
import type { TokenOverview, CpycatScore } from "@/lib/api";
import type { PlaceOrderResult } from "@/lib/hl-exchange";
// Note: wagmi + hl-exchange are dynamically imported in handleSubmit to avoid SSR/static build crash
import { useSafeAccount } from "@/hooks/use-safe-account";

interface TradingPanelProps {
  coin: string;
  overview: TokenOverview | null;
  score: CpycatScore | null;
}

type Side = "long" | "short";
type OrderType = "market" | "limit";

export function TradingPanel({ coin, overview, score }: TradingPanelProps) {
  const [side, setSide] = useState<Side>("long");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [size, setSize] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [leverage, setLeverageVal] = useState(5);
  const [tpPercent, setTpPercent] = useState("");
  const [slPercent, setSlPercent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<PlaceOrderResult | null>(null);
  const [leverageSet, setLeverageSet] = useState(false);

  const { address, isConnected } = useSafeAccount();

  const price = overview?.price ?? 0;
  const sizeNum = parseFloat(size) || 0;
  const notional = sizeNum * price;
  const margin = leverage > 0 ? notional / leverage : 0;

  const signalColor = score
    ? score.signal === "strong_buy" || score.signal === "buy"
      ? "text-[var(--hl-green)]"
      : score.signal === "strong_sell" || score.signal === "sell"
      ? "text-[var(--hl-red)]"
      : "text-[var(--hl-muted)]"
    : "";

  // Handle leverage change — set on HL when user adjusts
  const handleLeverageChange = useCallback(async (newLev: number) => {
    setLeverageVal(newLev);
    setLeverageSet(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!address || sizeNum <= 0) return;
    setSubmitting(true);
    setLastResult(null);

    try {
      // Dynamically import wagmi core + exchange lib (avoids SSR crash)
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"),
        import("@/lib/hl-exchange"),
        import("@/config/wagmi"),
      ]);

      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) {
        setLastResult({ success: false, error: "Wallet not connected" });
        setSubmitting(false);
        return;
      }

      // Set leverage first if not yet confirmed
      if (!leverageSet) {
        const levResult = await exchange.setLeverage(
          walletClient,
          address as `0x${string}`,
          coin,
          leverage,
        );
        if (!levResult.success) {
          setLastResult({ success: false, error: `Leverage: ${levResult.error}` });
          setSubmitting(false);
          return;
        }
        setLeverageSet(true);
      }

      // Place the order
      const result = await exchange.placeOrder(walletClient, address as `0x${string}`, {
        asset: coin,
        isBuy: side === "long",
        size: sizeNum,
        orderType,
        limitPrice: orderType === "limit" ? parseFloat(limitPrice) : undefined,
        slippageBps: 50, // 0.5% slippage for market
      });

      setLastResult(result);
      if (result.success) {
        setSize(""); // Clear size on success
      }
    } catch (err) {
      setLastResult({
        success: false,
        error: err instanceof Error ? err.message : "Transaction failed",
      });
    } finally {
      setSubmitting(false);
    }
  }, [address, coin, side, sizeNum, orderType, limitPrice, leverage, leverageSet]);

  return (
    <div className="flex flex-col h-full border-l border-[var(--hl-border)] bg-[var(--background)]">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[var(--hl-border)]">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-[var(--foreground)]">Trade {coin}</span>
          {score && (
            <span className={`text-[11px] font-medium ${signalColor}`}>
              HLOne {score.score} · {score.signal.replace("_", " ").toUpperCase()}
            </span>
          )}
        </div>
      </div>

      {/* Buy/Sell toggle */}
      <div className="grid grid-cols-2 gap-px bg-[var(--hl-border)] mx-3 mt-2 rounded overflow-hidden">
        <button
          onClick={() => setSide("long")}
          className={`py-1.5 text-[12px] font-semibold transition-colors ${
            side === "long"
              ? "bg-[var(--hl-green)] text-[var(--background)]"
              : "bg-[var(--hl-surface)] text-[var(--hl-muted)] hover:text-[var(--foreground)]"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setSide("short")}
          className={`py-1.5 text-[12px] font-semibold transition-colors ${
            side === "short"
              ? "bg-[var(--hl-red)] text-white"
              : "bg-[var(--hl-surface)] text-[var(--hl-muted)] hover:text-[var(--foreground)]"
          }`}
        >
          Short
        </button>
      </div>

      {/* Order type */}
      <div className="flex gap-2 px-3 mt-3">
        {(["market", "limit"] as OrderType[]).map(t => (
          <button
            key={t}
            onClick={() => setOrderType(t)}
            className={`px-3 py-1 text-[11px] font-medium rounded transition-colors ${
              t === orderType
                ? "bg-[var(--hl-surface)] text-[var(--foreground)]"
                : "text-[var(--hl-muted)] hover:text-[var(--hl-text)]"
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Form */}
      <div className="px-3 mt-3 space-y-2.5 flex-1">
        {/* Limit price */}
        {orderType === "limit" && (
          <div>
            <label className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider">Price</label>
            <input
              type="number"
              value={limitPrice}
              onChange={e => setLimitPrice(e.target.value)}
              placeholder={price.toString()}
              className="w-full mt-0.5 px-2 py-1.5 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] focus:border-[var(--hl-green)] outline-none"
            />
          </div>
        )}

        {/* Size */}
        <div>
          <label className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider">Size ({coin})</label>
          <input
            type="number"
            value={size}
            onChange={e => setSize(e.target.value)}
            placeholder="0.00"
            className="w-full mt-0.5 px-2 py-1.5 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] focus:border-[var(--hl-green)] outline-none"
          />
          {sizeNum > 0 && (
            <p className="text-[10px] text-[var(--hl-muted)] mt-0.5">
              ≈ ${notional.toLocaleString(undefined, { maximumFractionDigits: 2 })} notional
            </p>
          )}
        </div>

        {/* Leverage */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider">Leverage</label>
            <span className="text-[11px] font-medium text-[var(--foreground)]">{leverage}x</span>
          </div>
          <input
            type="range"
            min={1}
            max={50}
            value={leverage}
            onChange={e => handleLeverageChange(Number(e.target.value))}
            className="w-full mt-1 accent-[var(--hl-green)]"
          />
          <div className="flex justify-between text-[9px] text-[var(--hl-muted)]">
            <span>1x</span>
            <span>10x</span>
            <span>25x</span>
            <span>50x</span>
          </div>
        </div>

        {/* TP/SL */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-[var(--hl-green)] uppercase tracking-wider">TP %</label>
            <input
              type="number"
              value={tpPercent}
              onChange={e => setTpPercent(e.target.value)}
              placeholder="—"
              className="w-full mt-0.5 px-2 py-1 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[11px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none"
            />
          </div>
          <div>
            <label className="text-[10px] text-[var(--hl-red)] uppercase tracking-wider">SL %</label>
            <input
              type="number"
              value={slPercent}
              onChange={e => setSlPercent(e.target.value)}
              placeholder="—"
              className="w-full mt-0.5 px-2 py-1 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[11px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none"
            />
          </div>
        </div>

        {/* Margin summary */}
        {sizeNum > 0 && (
          <div className="bg-[var(--hl-surface)] rounded p-2 text-[10px] space-y-0.5">
            <div className="flex justify-between">
              <span className="text-[var(--hl-muted)]">Margin required</span>
              <span className="text-[var(--foreground)]">${margin.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--hl-muted)]">Fee (0.035%)</span>
              <span className="text-[var(--foreground)]">${(notional * 0.00035).toFixed(2)}</span>
            </div>
            {tpPercent && (
              <div className="flex justify-between">
                <span className="text-[var(--hl-green)]">TP price</span>
                <span className="text-[var(--hl-green)]">
                  ${(price * (1 + (side === "long" ? 1 : -1) * parseFloat(tpPercent) / 100)).toFixed(2)}
                </span>
              </div>
            )}
            {slPercent && (
              <div className="flex justify-between">
                <span className="text-[var(--hl-red)]">SL price</span>
                <span className="text-[var(--hl-red)]">
                  ${(price * (1 + (side === "long" ? -1 : 1) * parseFloat(slPercent) / 100)).toFixed(2)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Order result feedback */}
        {lastResult && (
          <div className={`rounded p-2 text-[10px] ${
            lastResult.success
              ? "bg-[rgba(80,210,193,0.1)] text-[var(--hl-green)]"
              : "bg-[rgba(240,88,88,0.1)] text-[var(--hl-red)]"
          }`}>
            {lastResult.success ? (
              <>
                Order filled{lastResult.avgPrice ? ` @ $${parseFloat(lastResult.avgPrice).toLocaleString()}` : ""}
                {lastResult.filledSize ? ` · ${lastResult.filledSize} ${coin}` : ""}
              </>
            ) : (
              <>{lastResult.error}</>
            )}
          </div>
        )}
      </div>

      {/* Submit button */}
      <div className="px-3 py-2 border-t border-[var(--hl-border)]">
        {isConnected ? (
          <button
            className={`w-full py-2 rounded font-semibold text-[13px] transition-colors disabled:opacity-50 ${
              side === "long"
                ? "bg-[var(--hl-green)] text-[var(--background)] hover:brightness-110"
                : "bg-[var(--hl-red)] text-white hover:brightness-110"
            }`}
            disabled={submitting || sizeNum <= 0}
            onClick={handleSubmit}
          >
            {submitting ? "Signing..." : `${side === "long" ? "Long" : "Short"} ${coin}`}
          </button>
        ) : (
          <button
            className="w-full py-2 rounded font-semibold text-[13px] bg-[var(--hl-surface)] text-[var(--hl-muted)] cursor-not-allowed"
            disabled
          >
            Connect wallet to trade
          </button>
        )}
        <p className="text-[9px] text-[var(--hl-muted)] text-center mt-1">
          {isConnected
            ? `Orders signed by your wallet · 0.035% taker fee`
            : "Connect wallet to trade · 0.035% taker fee"
          }
        </p>
      </div>
    </div>
  );
}
