"use client";

import { useState, useCallback, useEffect } from "react";
import type { TokenOverview, CpycatScore } from "@/lib/api";
import type { PlaceOrderResult } from "@/lib/hl-exchange";
import { BUILDER_FEE_PERCENT, BUILDER_FEE_DISPLAY } from "@/lib/hl-exchange";
import { useSafeAccount } from "@/hooks/use-safe-account";
import { hasDeriveOptions } from "./hype-options";

interface TradingPanelProps {
  coin: string;
  overview: TokenOverview | null;
  score: CpycatScore | null;
  onOpenOptionsChain?: (coin: string) => void;
}

type Side = "long" | "short";
type OrderType = "market" | "limit";
type MarginMode = "cross" | "isolated";

export function TradingPanel({ coin, overview, score, onOpenOptionsChain }: TradingPanelProps) {
  const [mode, setMode] = useState<"perp" | "options">("perp");
  const [side, setSide] = useState<Side>("long");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [size, setSize] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [leverage, setLeverageVal] = useState(5);
  const [marginMode, setMarginMode] = useState<MarginMode>("cross");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [showTpSl, setShowTpSl] = useState(false);
  const [tpPercent, setTpPercent] = useState("");
  const [slPercent, setSlPercent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<PlaceOrderResult | null>(null);
  const [leverageSet, setLeverageSet] = useState(false);
  const [builderApproved, setBuilderApproved] = useState(false);
  const [showLevModal, setShowLevModal] = useState(false);
  const [levInput, setLevInput] = useState("");
  const [sizePercent, setSizePercent] = useState(0);

  const { address, isConnected } = useSafeAccount();
  const [accountValue, setAccountValue] = useState(0);
  const [currentPosition, setCurrentPosition] = useState(0);

  // Fetch account value + current position from Hyperliquid
  useEffect(() => {
    if (!address) { setAccountValue(0); setCurrentPosition(0); return; }
    const fetchState = async () => {
      try {
        const res = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: address }),
        });
        const data = await res.json();
        const av = parseFloat(data?.marginSummary?.accountValue ?? "0");
        setAccountValue(av);
        // Find current position for this coin
        const pos = data?.assetPositions?.find((p: { position: { coin: string } }) =>
          p.position.coin === displayCoin
        );
        setCurrentPosition(pos ? parseFloat(pos.position.szi ?? "0") : 0);
      } catch { setAccountValue(0); setCurrentPosition(0); }
    };
    fetchState();
    const interval = window.setInterval(fetchState, 15_000);
    return () => clearInterval(interval);
  }, [address, coin]);

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

  // Handle size slider
  const handleSizeSlider = useCallback((pct: number) => {
    setSizePercent(pct);
    if (pct <= 0 || price <= 0) { setSize(""); return; }
    if (accountValue <= 0) return;
    const maxNotional = accountValue * leverage * (pct / 100);
    const assetSize = maxNotional / price;
    const decimals = price >= 1000 ? 4 : price >= 1 ? 2 : 6;
    setSize(assetSize.toFixed(decimals));
  }, [price, leverage, accountValue]);

  const handleLeverageChange = useCallback((newLev: number) => {
    setLeverageVal(newLev);
    setLeverageSet(false);
  }, []);

  const confirmLeverage = useCallback(() => {
    const val = parseInt(levInput);
    if (val >= 1 && val <= maxLev) {
      handleLeverageChange(val);
      setShowLevModal(false);
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

      if (!builderApproved) {
        console.log("[trade] Checking builder fee approval...");
        const alreadyApproved = await exchange.checkBuilderApproval(address as string);
        if (alreadyApproved) {
          setBuilderApproved(true);
        } else {
          console.log("[trade] Requesting builder fee approval...");
          const approvalResult = await exchange.approveBuilderFee(walletClient, address as `0x${string}`);
          if (!approvalResult.success) {
            setLastResult({ success: false, error: `Fee approval: ${approvalResult.error}` });
            setSubmitting(false);
            return;
          }
          setBuilderApproved(true);
        }
      }

      if (!leverageSet) {
        console.log(`[trade] Setting leverage to ${leverage}x (${marginMode})...`);
        const levResult = await exchange.setLeverage(walletClient, address as `0x${string}`, coin, leverage, marginMode === "cross");
        if (!levResult.success) {
          setLastResult({ success: false, error: `Leverage: ${levResult.error}` });
          setSubmitting(false);
          return;
        }
        setLeverageSet(true);
      }

      console.log("[trade] Placing order...");
      const orderStart = Date.now();
      const result = await exchange.placeOrder(walletClient, address as `0x${string}`, {
        asset: coin,
        isBuy: side === "long",
        size: sizeNum,
        orderType,
        limitPrice: orderType === "limit" ? parseFloat(limitPrice) : undefined,
        reduceOnly,
        slippageBps: 50,
      });
      const latencyMs = Date.now() - orderStart;

      console.log("[trade] Order result:", result);
      setLastResult(result);
      if (result.success) { setSize(""); setSizePercent(0); }

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
      setLastResult({ success: false, error: err instanceof Error ? err.message : "Transaction failed" });
    } finally {
      setSubmitting(false);
    }
  }, [address, coin, side, sizeNum, orderType, limitPrice, leverage, marginMode, leverageSet, builderApproved, reduceOnly]);

  const coinHasOptions = hasDeriveOptions(displayCoin);

  // Reset to perp mode when switching to coin without options
  useEffect(() => {
    if (!coinHasOptions) setMode("perp");
  }, [coinHasOptions]);

  return (
    <div className="flex flex-col h-full border-l border-[var(--hl-border)] bg-[var(--background)]">
      {/* Mode toggle: Perp | Options — only show if coin has Derive options */}
      {coinHasOptions && (
        <div className="flex items-center mx-3 mt-3 rounded overflow-hidden border border-[var(--hl-border)]">
          <button
            onClick={() => setMode("perp")}
            className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
              mode === "perp"
                ? "bg-[var(--hl-surface)] text-[var(--foreground)]"
                : "text-[var(--hl-muted)] hover:text-[var(--hl-text)]"
            }`}
          >
            Perp
          </button>
          <button
            onClick={() => setMode("options")}
            className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
              mode === "options"
                ? "bg-[rgba(168,85,247,0.15)] text-purple-400"
                : "text-[var(--hl-muted)] hover:text-[var(--hl-text)]"
            }`}
          >
            Options
          </button>
        </div>
      )}

      {/* ─── Options Mode ─── */}
      {mode === "options" && coinHasOptions && (
        <div className="flex flex-col flex-1 px-3 mt-3">
          <div className="text-center mb-4">
            <div className="text-[12px] font-semibold text-purple-400 mb-1">{displayCoin} Options</div>
            <div className="text-[10px] text-[var(--hl-muted)]">via Derive (formerly Lyra)</div>
          </div>

          {/* Quick option type selector */}
          <div className="grid grid-cols-2 gap-px bg-[var(--hl-border)] rounded overflow-hidden mb-3">
            <button
              className="py-2 text-[12px] font-semibold bg-[rgba(80,210,193,0.15)] text-[var(--hl-green)] hover:brightness-110 transition-colors"
              onClick={() => onOpenOptionsChain?.(displayCoin)}
            >
              Buy Call
            </button>
            <button
              className="py-2 text-[12px] font-semibold bg-[rgba(240,88,88,0.15)] text-[var(--hl-red)] hover:brightness-110 transition-colors"
              onClick={() => onOpenOptionsChain?.(displayCoin)}
            >
              Buy Put
            </button>
          </div>

          {/* Info card */}
          <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-3 space-y-2 mb-3">
            <p className="text-[10px] text-[var(--hl-muted)]">
              Options are traded on Derive, a decentralized options protocol. View the full chain to see strikes, expiries, Greeks, and pricing.
            </p>
            <div className="text-[10px] space-y-1">
              <div className="flex justify-between">
                <span className="text-[var(--hl-muted)]">Maker Fee</span>
                <span className="text-[var(--hl-text)]">0.01%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--hl-muted)]">Taker Fee</span>
                <span className="text-[var(--hl-text)]">0.03%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--hl-muted)]">Settlement</span>
                <span className="text-[var(--hl-text)]">USDC</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--hl-muted)]">Type</span>
                <span className="text-[var(--hl-text)]">European</span>
              </div>
            </div>
          </div>

          {/* View full chain button */}
          <button
            onClick={() => onOpenOptionsChain?.(displayCoin)}
            className="w-full py-2.5 rounded font-semibold text-[12px] bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30 transition-colors mb-2"
          >
            View Options Chain
          </button>

          {/* Trade on Derive link */}
          <a
            href={`https://derive.xyz/trade/options/${displayCoin}`}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full py-2.5 rounded font-semibold text-[12px] bg-[var(--hl-surface)] text-[var(--hl-text)] border border-[var(--hl-border)] hover:bg-[var(--hl-surface-hover)] transition-colors text-center block"
          >
            Trade on Derive &rarr;
          </a>

          <div className="mt-auto pt-3 text-[9px] text-[var(--hl-muted)] text-center">
            Options execution requires signing via Derive. Full chain view shows live Greeks, IV, and order book depth.
          </div>
        </div>
      )}

      {/* ─── Perp Mode (existing) ─── */}
      {mode === "perp" && <>
      {/* Top row: Isolated / Leverage / Classic — HL style */}
      <div className="grid grid-cols-3 gap-px mx-3 mt-3">
        <button
          onClick={() => { setMarginMode(m => m === "isolated" ? "cross" : "isolated"); setLeverageSet(false); }}
          className="py-1.5 text-[11px] font-medium rounded-l border border-[var(--hl-border)] bg-[var(--hl-surface)] text-[var(--foreground)] hover:bg-[var(--hl-surface-hover)] transition-colors"
        >
          {marginMode === "cross" ? "Cross" : "Isolated"}
        </button>
        <button
          onClick={() => { setShowLevModal(true); setLevInput(leverage.toString()); }}
          className="py-1.5 text-[11px] font-medium border-y border-[var(--hl-border)] bg-[var(--hl-surface)] text-[var(--foreground)] hover:bg-[var(--hl-surface-hover)] transition-colors tabular-nums"
        >
          {leverage}x
        </button>
        <div className="py-1.5 text-[11px] font-medium rounded-r border border-[var(--hl-border)] bg-[var(--hl-surface)] text-[var(--hl-muted)] text-center cursor-default">
          Classic
        </div>
      </div>

      {/* Order type tabs — underline style */}
      <div className="flex items-center border-b border-[var(--hl-border)] mx-3 mt-3">
        {(["market", "limit"] as OrderType[]).map(t => (
          <button
            key={t}
            onClick={() => setOrderType(t)}
            className={`px-3 pb-1.5 text-[12px] font-medium transition-colors border-b-2 -mb-px ${
              t === orderType
                ? "border-[var(--foreground)] text-[var(--foreground)]"
                : "border-transparent text-[var(--hl-muted)] hover:text-[var(--hl-text)]"
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Buy/Long | Sell/Short toggle */}
      <div className="grid grid-cols-2 gap-px bg-[var(--hl-border)] mx-3 mt-3 rounded overflow-hidden">
        <button
          onClick={() => setSide("long")}
          className={`py-2 text-[12px] font-semibold transition-colors ${
            side === "long"
              ? "bg-[var(--hl-green)] text-[var(--background)]"
              : "bg-[var(--hl-surface)] text-[var(--hl-muted)] hover:text-[var(--foreground)]"
          }`}
        >
          Buy / Long
        </button>
        <button
          onClick={() => setSide("short")}
          className={`py-2 text-[12px] font-semibold transition-colors ${
            side === "short"
              ? "bg-[var(--hl-red)] text-white"
              : "bg-[var(--hl-surface)] text-[var(--hl-muted)] hover:text-[var(--foreground)]"
          }`}
        >
          Sell / Short
        </button>
      </div>

      {/* Available + Current Position */}
      <div className="px-3 mt-3 space-y-1">
        <div className="flex justify-between text-[11px]">
          <span className="text-[var(--hl-muted)]">Available to Trade</span>
          <span className="text-[var(--foreground)] tabular-nums">
            {isConnected ? `${accountValue.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC` : "0.00 USDC"}
          </span>
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-[var(--hl-muted)]">Current Position</span>
          <span className={`tabular-nums ${currentPosition > 0 ? "text-[var(--hl-green)]" : currentPosition < 0 ? "text-[var(--hl-red)]" : "text-[var(--foreground)]"}`}>
            {currentPosition !== 0 ? currentPosition.toFixed(4) : "0.00"} {displayCoin}
          </span>
        </div>
      </div>

      {/* Form */}
      <div className="px-3 mt-3 space-y-2.5 flex-1">
        {/* Limit price */}
        {orderType === "limit" && (
          <div className="flex items-center bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-2 py-1.5">
            <span className="text-[10px] text-[var(--hl-muted)] mr-2 shrink-0">Price</span>
            <input
              type="number"
              value={limitPrice}
              onChange={e => setLimitPrice(e.target.value)}
              placeholder={price.toString()}
              className="flex-1 bg-transparent text-right text-[12px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none"
            />
            <span className="text-[10px] text-[var(--hl-muted)] ml-2">USD</span>
          </div>
        )}

        {/* Size input — HL style with coin label */}
        <div className="flex items-center bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-2 py-1.5">
          <span className="text-[10px] text-[var(--hl-muted)] mr-2 shrink-0">Size</span>
          <input
            type="number"
            value={size}
            onChange={e => { setSize(e.target.value); setSizePercent(0); }}
            placeholder="0.00"
            className="flex-1 bg-transparent text-right text-[12px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none"
          />
          <span className="text-[10px] text-[var(--hl-muted)] ml-2 shrink-0">{displayCoin}</span>
        </div>

        {/* Size slider with dot stops — HL style */}
        <div className="flex items-center gap-2">
          <div className="flex-1 relative h-5 flex items-center">
            {/* Track background */}
            <div className="absolute inset-x-0 h-[2px] bg-[var(--hl-border)] rounded" style={{ top: "50%", transform: "translateY(-50%)" }} />
            {/* Filled portion */}
            <div className="absolute h-[2px] bg-[var(--hl-green)] rounded" style={{ top: "50%", transform: "translateY(-50%)", left: 0, width: `${sizePercent}%` }} />
            {/* Dot stops */}
            {[0, 25, 50, 75, 100].map(pct => (
              <button
                key={pct}
                onClick={() => handleSizeSlider(pct)}
                className="absolute w-2 h-2 rounded-full transition-colors -translate-x-1/2"
                style={{ left: `${pct}%`, backgroundColor: sizePercent >= pct ? "var(--hl-green)" : "var(--hl-border)" }}
              />
            ))}
            {/* Draggable thumb */}
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={sizePercent}
              onChange={e => handleSizeSlider(Number(e.target.value))}
              className="absolute inset-0 w-full opacity-0 cursor-pointer"
            />
            {/* Visual thumb */}
            <div
              className="absolute w-3.5 h-3.5 rounded-full border-2 border-[var(--hl-green)] bg-[var(--background)] -translate-x-1/2 pointer-events-none"
              style={{ left: `${sizePercent}%` }}
            />
          </div>
          {/* Percentage input */}
          <div className="flex items-center bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-1.5 py-0.5 w-[52px]">
            <input
              type="number"
              min={0}
              max={100}
              value={sizePercent || ""}
              onChange={e => handleSizeSlider(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
              placeholder="0"
              className="w-full bg-transparent text-right text-[11px] text-[var(--foreground)] tabular-nums outline-none"
            />
            <span className="text-[10px] text-[var(--hl-muted)] ml-0.5">%</span>
          </div>
        </div>

        {/* Notional + margin display */}
        {sizeNum > 0 && (
          <div className="text-[10px] text-[var(--hl-muted)] space-y-0.5">
            <div className="flex justify-between">
              <span>Notional</span>
              <span className="text-[var(--foreground)] tabular-nums">${notional.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>
            <div className="flex justify-between">
              <span>Margin</span>
              <span className="text-[var(--foreground)] tabular-nums">${margin.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span>Fees (0.035% + {BUILDER_FEE_DISPLAY})</span>
              <span className="text-[var(--foreground)] tabular-nums">${(notional * (0.00035 + BUILDER_FEE_PERCENT)).toFixed(2)}</span>
            </div>
          </div>
        )}

        {/* Reduce Only */}
        <label className="flex items-center gap-2 cursor-pointer">
          <div
            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              reduceOnly ? "bg-[var(--hl-green)] border-[var(--hl-green)]" : "border-[var(--hl-border)] bg-transparent"
            }`}
            onClick={() => setReduceOnly(!reduceOnly)}
          >
            {reduceOnly && (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 5L4 7L8 3" stroke="var(--background)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
          <span className="text-[11px] text-[var(--foreground)]" onClick={() => setReduceOnly(!reduceOnly)}>Reduce Only</span>
        </label>

        {/* Take Profit / Stop Loss checkbox */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <div
              className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                showTpSl ? "bg-[var(--hl-green)] border-[var(--hl-green)]" : "border-[var(--hl-border)] bg-transparent"
              }`}
              onClick={() => setShowTpSl(!showTpSl)}
            >
              {showTpSl && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 5L4 7L8 3" stroke="var(--background)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            <span className="text-[11px] text-[var(--foreground)]" onClick={() => setShowTpSl(!showTpSl)}>Take Profit / Stop Loss</span>
          </label>

          {showTpSl && (
            <div className="grid grid-cols-2 gap-2 mt-2 pl-6">
              <div className="flex items-center bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-2 py-1">
                <span className="text-[9px] text-[var(--hl-green)] mr-1 shrink-0">TP</span>
                <input
                  type="number"
                  value={tpPercent}
                  onChange={e => setTpPercent(e.target.value)}
                  placeholder="—"
                  className="flex-1 bg-transparent text-right text-[11px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none"
                />
                <span className="text-[9px] text-[var(--hl-muted)] ml-1">%</span>
              </div>
              <div className="flex items-center bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-2 py-1">
                <span className="text-[9px] text-[var(--hl-red)] mr-1 shrink-0">SL</span>
                <input
                  type="number"
                  value={slPercent}
                  onChange={e => setSlPercent(e.target.value)}
                  placeholder="—"
                  className="flex-1 bg-transparent text-right text-[11px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none"
                />
                <span className="text-[9px] text-[var(--hl-muted)] ml-1">%</span>
              </div>
              {(tpPercent || slPercent) && price > 0 && (
                <div className="col-span-2 text-[9px] text-[var(--hl-muted)] space-y-0.5">
                  {tpPercent && (
                    <div className="flex justify-between">
                      <span className="text-[var(--hl-green)]">TP price</span>
                      <span className="text-[var(--hl-green)]">${(price * (1 + (side === "long" ? 1 : -1) * parseFloat(tpPercent) / 100)).toFixed(2)}</span>
                    </div>
                  )}
                  {slPercent && (
                    <div className="flex justify-between">
                      <span className="text-[var(--hl-red)]">SL price</span>
                      <span className="text-[var(--hl-red)]">${(price * (1 + (side === "long" ? -1 : 1) * parseFloat(slPercent) / 100)).toFixed(2)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Order result feedback */}
        {lastResult && (
          <div className={`rounded p-2 text-[10px] ${
            lastResult.success
              ? "bg-[rgba(80,210,193,0.1)] text-[var(--hl-green)]"
              : "bg-[rgba(240,88,88,0.1)] text-[var(--hl-red)]"
          }`}>
            {lastResult.success ? (
              <>Filled{lastResult.avgPrice ? ` @ $${parseFloat(lastResult.avgPrice).toLocaleString()}` : ""}{lastResult.filledSize ? ` · ${lastResult.filledSize} ${displayCoin}` : ""}</>
            ) : (
              <>{lastResult.error}</>
            )}
          </div>
        )}
      </div>

      {/* Submit button */}
      <div className="px-3 py-3 mt-auto">
        {isConnected ? (
          <button
            className={`w-full py-2.5 rounded font-semibold text-[13px] transition-colors ${
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
                ? `${side === "long" ? "Buy / Long" : "Sell / Short"}`
                : `${side === "long" ? "Buy / Long" : "Sell / Short"} ${displayCoin}`}
          </button>
        ) : (
          <button
            className="w-full py-2.5 rounded font-semibold text-[13px] bg-[var(--hl-green)] text-[var(--background)] hover:brightness-110 transition-colors"
            onClick={() => {
              // Trigger wallet connect via RainbowKit
              document.querySelector<HTMLButtonElement>('[data-testid="rk-connect-button"]')?.click();
            }}
          >
            Connect Wallet
          </button>
        )}
      </div>

      </>}

      {/* ── Leverage Modal (centered, HL style) ── */}
      {showLevModal && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowLevModal(false)} />
          <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[320px] bg-[var(--background)] border border-[var(--hl-border)] rounded-lg shadow-2xl p-5">
            {/* Close */}
            <button
              onClick={() => setShowLevModal(false)}
              className="absolute top-3 right-3 text-[var(--hl-muted)] hover:text-[var(--foreground)] transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4L12 12M12 4L4 12" />
              </svg>
            </button>

            <h3 className="text-[15px] font-semibold text-[var(--foreground)] text-center">Adjust Leverage</h3>
            <p className="text-[11px] text-[var(--hl-muted)] text-center mt-1">
              Control the leverage used for {displayCoin} positions. The maximum leverage is {maxLev}x.
            </p>

            {/* Slider */}
            <div className="mt-5">
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
                <span>{Math.round(maxLev / 4)}x</span>
                <span>{Math.round(maxLev / 2)}x</span>
                <span>{Math.round(maxLev * 3 / 4)}x</span>
                <span>{maxLev}x</span>
              </div>
            </div>

            {/* Input */}
            <div className="flex items-center justify-end gap-2 mt-4">
              <input
                type="number"
                min={1}
                max={maxLev}
                value={levInput}
                onChange={e => setLevInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && confirmLeverage()}
                className="w-[60px] px-2 py-1.5 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[13px] text-center text-[var(--foreground)] tabular-nums outline-none focus:border-[var(--hl-green)]"
                autoFocus
              />
              <span className="text-[13px] text-[var(--hl-muted)]">x</span>
            </div>

            {/* Confirm button */}
            <button
              onClick={confirmLeverage}
              className="w-full mt-4 py-2.5 rounded font-semibold text-[13px] bg-[var(--hl-green)] text-[var(--background)] hover:brightness-110 transition-colors"
            >
              Confirm
            </button>

            {/* Warning */}
            <div className="mt-3 px-3 py-2 rounded bg-[rgba(240,88,88,0.08)] border border-[rgba(240,88,88,0.2)]">
              <p className="text-[10px] text-[var(--hl-red)] text-center">
                Note that setting a higher leverage increases the risk of liquidation.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
