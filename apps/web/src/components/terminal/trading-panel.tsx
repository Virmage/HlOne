"use client";

import { useState, useCallback, useEffect } from "react";
import type { TokenOverview, CpycatScore } from "@/lib/api";
import type { PlaceOrderResult } from "@/lib/hl-exchange";
import { BUILDER_FEE_PERCENT, BUILDER_FEE_DISPLAY } from "@/lib/hl-exchange";
import { useSafeAccount } from "@/hooks/use-safe-account";

interface TradingPanelProps {
  coin: string;
  overview: TokenOverview | null;
  score: CpycatScore | null;
}

type Side = "long" | "short";
type OrderType = "market" | "limit";
type MarginMode = "cross" | "isolated";

export function TradingPanel({ coin, overview, score }: TradingPanelProps) {
  const [side, setSide] = useState<Side>("long");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [size, setSize] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [leverage, setLeverageVal] = useState(5);
  const [marginMode, setMarginMode] = useState<MarginMode>("cross");
  const [tpPercent, setTpPercent] = useState("");
  const [slPercent, setSlPercent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<PlaceOrderResult | null>(null);
  const [leverageSet, setLeverageSet] = useState(false);
  const [builderApproved, setBuilderApproved] = useState(false);
  const [showLevPopup, setShowLevPopup] = useState(false);
  const [levInput, setLevInput] = useState("");
  const [sizePercent, setSizePercent] = useState(0); // 0-100% of available margin

  const { address, isConnected } = useSafeAccount();
  const [accountValue, setAccountValue] = useState(0);

  // Fetch account value from Hyperliquid when wallet connected
  useEffect(() => {
    if (!address) { setAccountValue(0); return; }
    const fetchAV = async () => {
      try {
        const res = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: address }),
        });
        const data = await res.json();
        const av = parseFloat(data?.marginSummary?.accountValue ?? "0");
        setAccountValue(av);
      } catch { setAccountValue(0); }
    };
    fetchAV();
    const interval = window.setInterval(fetchAV, 30_000); // refresh every 30s
    return () => clearInterval(interval);
  }, [address]);

  // Clamp leverage when switching to a token with lower max
  useEffect(() => {
    const max = overview?.maxLeverage ?? 50;
    if (leverage > max) setLeverageVal(max);
  }, [coin, overview?.maxLeverage]);

  const price = overview?.price ?? 0;
  const maxLev = overview?.maxLeverage ?? 50;
  const sizeNum = parseFloat(size) || 0;
  const notional = sizeNum * price;
  const margin = leverage > 0 ? notional / leverage : 0;
  const displayCoin = coin.includes(":") ? coin.split(":")[1] : coin;

  const signalColor = score
    ? score.signal === "strong_buy" || score.signal === "buy"
      ? "text-[var(--hl-green)]"
      : score.signal === "strong_sell" || score.signal === "sell"
      ? "text-[var(--hl-red)]"
      : "text-[var(--hl-muted)]"
    : "";

  // Handle size slider — convert percentage to size in asset units
  const handleSizeSlider = useCallback((pct: number) => {
    setSizePercent(pct);
    if (pct <= 0 || price <= 0) {
      setSize("");
      return;
    }
    if (accountValue <= 0) return;
    const maxNotional = accountValue * leverage * (pct / 100);
    const assetSize = maxNotional / price;
    // Round to reasonable precision
    const decimals = price >= 1000 ? 4 : price >= 1 ? 2 : 6;
    setSize(assetSize.toFixed(decimals));
  }, [price, leverage, accountValue]);

  // Handle leverage change
  const handleLeverageChange = useCallback((newLev: number) => {
    setLeverageVal(newLev);
    setLeverageSet(false);
  }, []);

  // Leverage popup confirm
  const confirmLeverage = useCallback(() => {
    const val = parseInt(levInput);
    if (val >= 1 && val <= maxLev) {
      handleLeverageChange(val);
      setShowLevPopup(false);
      setLevInput("");
    }
  }, [levInput, maxLev, handleLeverageChange]);

  const handleSubmit = useCallback(async () => {
    if (!address || sizeNum <= 0) return;
    setSubmitting(true);
    setLastResult(null);
    console.log(`[trade] Starting ${side} ${coin} size=${sizeNum} type=${orderType} lev=${leverage}x margin=${marginMode}`);

    try {
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"),
        import("@/lib/hl-exchange"),
        import("@/config/wagmi"),
      ]);

      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) {
        console.error("[trade] No wallet client");
        setLastResult({ success: false, error: "Wallet not connected" });
        setSubmitting(false);
        return;
      }
      console.log("[trade] Wallet client OK, address:", address);

      // Check + request builder fee approval (one-time per wallet)
      if (!builderApproved) {
        console.log("[trade] Checking builder fee approval...");
        const alreadyApproved = await exchange.checkBuilderApproval(address as string);
        if (alreadyApproved) {
          console.log("[trade] Builder fee already approved");
          setBuilderApproved(true);
        } else {
          console.log("[trade] Requesting builder fee approval signature...");
          const approvalResult = await exchange.approveBuilderFee(
            walletClient,
            address as `0x${string}`,
          );
          if (!approvalResult.success) {
            console.error("[trade] Builder fee approval failed:", approvalResult.error);
            setLastResult({ success: false, error: `Fee approval: ${approvalResult.error}` });
            setSubmitting(false);
            return;
          }
          console.log("[trade] Builder fee approved");
          setBuilderApproved(true);
        }
      }

      // Set leverage first if not yet confirmed
      if (!leverageSet) {
        console.log(`[trade] Setting leverage to ${leverage}x (${marginMode})...`);
        const levResult = await exchange.setLeverage(
          walletClient,
          address as `0x${string}`,
          coin,
          leverage,
          marginMode === "cross",
        );
        if (!levResult.success) {
          setLastResult({ success: false, error: `Leverage: ${levResult.error}` });
          setSubmitting(false);
          return;
        }
        setLeverageSet(true);
      }

      // Place the order
      console.log("[trade] Placing order...");
      const orderStart = Date.now();
      const result = await exchange.placeOrder(walletClient, address as `0x${string}`, {
        asset: coin,
        isBuy: side === "long",
        size: sizeNum,
        orderType,
        limitPrice: orderType === "limit" ? parseFloat(limitPrice) : undefined,
        slippageBps: 50,
      });
      const latencyMs = Date.now() - orderStart;

      console.log("[trade] Order result:", result);
      setLastResult(result);
      if (result.success) {
        setSize("");
        setSizePercent(0);
      }

      // Log trade to backend (fire-and-forget)
      const currentPrice = overview?.price ?? 0;
      fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/market/trade-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAddress: address, asset: coin, side: side === "long" ? "buy" : "sell",
          orderType, size: sizeNum, price: currentPrice, success: result.success,
          orderId: result.orderId, filledSize: result.filledSize, avgPrice: result.avgPrice,
          error: result.error, latencyMs,
        }),
      }).catch(() => {});
    } catch (err) {
      setLastResult({
        success: false,
        error: err instanceof Error ? err.message : "Transaction failed",
      });
    } finally {
      setSubmitting(false);
    }
  }, [address, coin, side, sizeNum, orderType, limitPrice, leverage, marginMode, leverageSet, builderApproved]);

  return (
    <div className="flex flex-col h-full border-l border-[var(--hl-border)] bg-[var(--background)]">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[var(--hl-border)]">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-[var(--foreground)]">Trade {displayCoin}</span>
          {score && (
            <span className={`text-[11px] font-medium ${signalColor}`} title="CPYCAT Score">
              Score {score.score} · {score.signal.replace("_", " ").toUpperCase()}
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

      {/* Cross/Isolated + Leverage — HL style */}
      <div className="flex items-center gap-1.5 px-3 mt-2">
        {/* Cross / Isolated toggle */}
        <div className="flex rounded overflow-hidden border border-[var(--hl-border)]">
          <button
            onClick={() => { setMarginMode("cross"); setLeverageSet(false); }}
            className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
              marginMode === "cross"
                ? "bg-[var(--hl-surface)] text-[var(--foreground)]"
                : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
            }`}
          >
            Cross
          </button>
          <button
            onClick={() => { setMarginMode("isolated"); setLeverageSet(false); }}
            className={`px-2 py-0.5 text-[10px] font-medium border-l border-[var(--hl-border)] transition-colors ${
              marginMode === "isolated"
                ? "bg-[var(--hl-surface)] text-[var(--foreground)]"
                : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
            }`}
          >
            Isolated
          </button>
        </div>

        {/* Leverage button */}
        <div className="relative">
          <button
            onClick={() => { setShowLevPopup(!showLevPopup); setLevInput(leverage.toString()); }}
            className="px-2 py-0.5 text-[10px] font-medium rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] text-[var(--foreground)] hover:bg-[var(--hl-surface-hover)] transition-colors tabular-nums"
          >
            {leverage}x
          </button>

          {/* Leverage popup */}
          {showLevPopup && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-[var(--background)] border border-[var(--hl-border)] rounded-md shadow-lg p-3 w-[180px]">
              <div className="text-[10px] text-[var(--hl-muted)] mb-2">Leverage (1-{maxLev}x)</div>
              <div className="flex gap-1.5 mb-2">
                <input
                  type="number"
                  min={1}
                  max={maxLev}
                  value={levInput}
                  onChange={e => setLevInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && confirmLeverage()}
                  className="flex-1 px-2 py-1 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[11px] text-[var(--foreground)] tabular-nums outline-none focus:border-[var(--hl-green)]"
                  autoFocus
                />
                <button
                  onClick={confirmLeverage}
                  className="px-2 py-1 bg-[var(--hl-green)] text-[var(--background)] rounded text-[10px] font-medium"
                >
                  Set
                </button>
              </div>
              <input
                type="range"
                min={1}
                max={maxLev}
                value={parseInt(levInput) || leverage}
                onChange={e => setLevInput(e.target.value)}
                className="w-full accent-[var(--hl-green)]"
              />
              <div className="flex justify-between text-[9px] text-[var(--hl-muted)] mt-0.5">
                <span>1x</span>
                <span>{Math.round(maxLev / 2)}x</span>
                <span>{maxLev}x</span>
              </div>
              {/* Quick presets */}
              <div className="flex gap-1 mt-2">
                {[1, 3, 5, 10, 20].filter(v => v <= maxLev).map(v => (
                  <button
                    key={v}
                    onClick={() => { handleLeverageChange(v); setShowLevPopup(false); }}
                    className={`flex-1 py-0.5 text-[9px] rounded border transition-colors ${
                      leverage === v
                        ? "border-[var(--hl-green)] text-[var(--hl-green)]"
                        : "border-[var(--hl-border)] text-[var(--hl-muted)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {v}x
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Order type */}
      <div className="flex gap-2 px-3 mt-2">
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
      <div className="px-3 mt-2 space-y-2 flex-1">
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

        {/* Size input */}
        <div>
          <label className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider">Size ({displayCoin})</label>
          <input
            type="number"
            value={size}
            onChange={e => { setSize(e.target.value); setSizePercent(0); }}
            placeholder="0.00"
            className="w-full mt-0.5 px-2 py-1.5 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] focus:border-[var(--hl-green)] outline-none"
          />
        </div>

        {/* Account value display */}
        {isConnected && accountValue > 0 && (
          <div className="flex justify-between text-[10px]">
            <span className="text-[var(--hl-muted)]">Available</span>
            <span className="text-[var(--foreground)] tabular-nums">${accountValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </div>
        )}

        {/* Size slider — percentage of available margin */}
        <div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={sizePercent}
            onChange={e => handleSizeSlider(Number(e.target.value))}
            className="w-full accent-[var(--hl-green)]"
          />
          <div className="flex justify-between mt-0.5">
            {[0, 25, 50, 75, 100].map(pct => (
              <button
                key={pct}
                onClick={() => handleSizeSlider(pct)}
                className={`text-[9px] px-1 py-0.5 rounded transition-colors ${
                  sizePercent === pct
                    ? "text-[var(--hl-green)] font-medium"
                    : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>

        {/* Notional display */}
        {sizeNum > 0 && (
          <p className="text-[10px] text-[var(--hl-muted)]">
            ≈ ${notional.toLocaleString(undefined, { maximumFractionDigits: 2 })} notional · ${margin.toFixed(2)} margin
          </p>
        )}

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
              <span className="text-[var(--hl-muted)]">HL taker fee (0.035%)</span>
              <span className="text-[var(--foreground)]">${(notional * 0.00035).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--hl-muted)]">HLOne fee ({BUILDER_FEE_DISPLAY})</span>
              <span className="text-[var(--foreground)]">${(notional * BUILDER_FEE_PERCENT).toFixed(2)}</span>
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
            className={`w-full py-2 rounded font-semibold text-[13px] transition-colors ${
              sizeNum <= 0
                ? "bg-[var(--hl-surface)] text-[var(--hl-muted)] cursor-not-allowed"
                : side === "long"
                  ? "bg-[var(--hl-green)] text-[var(--background)] hover:brightness-110"
                  : "bg-[var(--hl-red)] text-white hover:brightness-110"
            } ${submitting ? "opacity-50" : ""}`}
            disabled={submitting || sizeNum <= 0}
            onClick={handleSubmit}
          >
            {submitting
              ? "Signing..."
              : sizeNum <= 0
                ? "Enter size to trade"
                : `${side === "long" ? "Long" : "Short"} ${displayCoin}`}
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
            ? `${marginMode === "cross" ? "Cross" : "Isolated"} · ${leverage}x · 0.035% + ${BUILDER_FEE_DISPLAY}`
            : `Connect wallet · 0.035% + ${BUILDER_FEE_DISPLAY} fee`
          }
        </p>
      </div>

      {/* Click outside to close leverage popup */}
      {showLevPopup && (
        <div className="fixed inset-0 z-40" onClick={() => setShowLevPopup(false)} />
      )}
    </div>
  );
}
