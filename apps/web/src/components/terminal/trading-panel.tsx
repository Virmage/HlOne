"use client";

import { useState, useCallback, useEffect } from "react";
import type { TokenOverview, HLOneScore } from "@/lib/api";
import type { PlaceOrderResult } from "@/lib/hl-exchange";
import { BUILDER_FEE_PERCENT, BUILDER_FEE_DISPLAY } from "@/lib/hl-exchange";
import { useSafeAccount } from "@/hooks/use-safe-account";
import { useGeoCheck } from "@/hooks/use-geo-check";
import { hasDeriveOptions } from "./hype-options";
import type { SelectedOption } from "./inline-options-chain";

interface TradingPanelProps {
  coin: string;
  overview: TokenOverview | null;
  score: HLOneScore | null;
  onOpenOptionsChain?: (coin: string) => void;
  tradingMode?: "perp" | "options";
  onTradingModeChange?: (mode: "perp" | "options") => void;
  selectedOption?: SelectedOption | null;
  onClearOption?: () => void;
}

type Side = "long" | "short";
type OrderType = "market" | "limit";
type MarginMode = "cross" | "isolated";

export function TradingPanel({ coin, overview, score, onOpenOptionsChain, tradingMode, onTradingModeChange, selectedOption, onClearOption }: TradingPanelProps) {
  const mode = tradingMode ?? "perp";
  const setMode = (m: "perp" | "options") => onTradingModeChange?.(m);
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

  // Fetch account value + current position — skip when tab hidden
  useEffect(() => {
    if (!address) { setAccountValue(0); setCurrentPosition(0); return; }
    const fetchState = async () => {
      if (document.hidden) return; // skip when tab not visible
      try {
        const res = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: address }),
        });
        const data = await res.json();
        const av = parseFloat(data?.marginSummary?.accountValue ?? "0");
        setAccountValue(av);
        const pos = data?.assetPositions?.find((p: { position: { coin: string } }) =>
          p.position.coin === displayCoin
        );
        setCurrentPosition(pos ? parseFloat(pos.position.szi ?? "0") : 0);
      } catch { setAccountValue(0); setCurrentPosition(0); }
    };
    fetchState();
    const interval = window.setInterval(fetchState, 30_000); // 30s instead of 15s
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

      // Step 1: Ensure agent wallet (one-time MetaMask approval)
      console.log("[trade] Ensuring agent wallet...");
      let agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
      if (agentResult.error) {
        setLastResult({ success: false, error: `Agent setup: ${agentResult.error}` });
        setSubmitting(false);
        return;
      }
      let agentKey = agentResult.agentKey;

      // Step 2: Builder fee approval (MetaMask, one-time)
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

      // Helper: re-create agent if stale
      const refreshAgent = async (): Promise<boolean> => {
        console.log("[trade] Agent stale, re-approving...");
        agentResult = await exchange.ensureAgent(walletClient, address as `0x${string}`);
        if (agentResult.error) {
          setLastResult({ success: false, error: `Agent re-setup: ${agentResult.error}` });
          return false;
        }
        agentKey = agentResult.agentKey;
        return true;
      };

      // Step 3: Set leverage (signed locally with agent key — no popup)
      if (!leverageSet) {
        console.log(`[trade] Setting leverage to ${leverage}x (${marginMode})...`);
        let levResult = await exchange.setLeverage(agentKey, address as `0x${string}`, coin, leverage, marginMode === "cross");
        if (!levResult.success && levResult.error === exchange.STALE_AGENT_MSG) {
          if (!(await refreshAgent())) { setSubmitting(false); return; }
          levResult = await exchange.setLeverage(agentKey, address as `0x${string}`, coin, leverage, marginMode === "cross");
        }
        if (!levResult.success) {
          setLastResult({ success: false, error: `Leverage: ${levResult.error}` });
          setSubmitting(false);
          return;
        }
        setLeverageSet(true);
      }

      // Step 4: Place order (signed locally with agent key — no popup)
      console.log("[trade] Placing order...");
      const orderStart = Date.now();
      let result = await exchange.placeOrder(agentKey, address as `0x${string}`, {
        asset: coin,
        isBuy: side === "long",
        size: sizeNum,
        orderType,
        limitPrice: orderType === "limit" ? parseFloat(limitPrice) : undefined,
        reduceOnly,
        slippageBps: 50,
      });
      if (!result.success && result.error === exchange.STALE_AGENT_MSG) {
        if (await refreshAgent()) {
          result = await exchange.placeOrder(agentKey, address as `0x${string}`, {
            asset: coin, isBuy: side === "long", size: sizeNum, orderType,
            limitPrice: orderType === "limit" ? parseFloat(limitPrice) : undefined,
            reduceOnly, slippageBps: 50,
          });
        }
      }
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
    if (!coinHasOptions) onTradingModeChange?.("perp");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coinHasOptions]);

  return (
    <div className="flex flex-col h-full border-l border-[var(--hl-border)] bg-[var(--background)]">
      {/* Perps / Options tab bar — always visible at top, styled like header nav */}
      {coinHasOptions && (
        <div className="flex items-center border-b border-[var(--hl-border)] shrink-0">
          <button
            onClick={() => setMode("perp")}
            className={`px-4 py-2 text-[12px] font-medium transition-colors border-b-2 -mb-px ${
              mode === "perp"
                ? "text-[var(--foreground)] border-[var(--hl-accent)]"
                : "text-[var(--hl-muted)] border-transparent hover:text-[var(--foreground)]"
            }`}
          >
            Perps
          </button>
          <button
            onClick={() => setMode("options")}
            className={`px-4 py-2 text-[12px] font-medium transition-colors border-b-2 -mb-px ${
              mode === "options"
                ? "text-purple-400 border-purple-400"
                : "text-[var(--hl-muted)] border-transparent hover:text-[var(--foreground)]"
            }`}
          >
            Options
          </button>
        </div>
      )}

      {/* ─── Options Mode: Order Entry ─── */}
      {mode === "options" && coinHasOptions && (
        <OptionsOrderPanel
          coin={displayCoin}
          selectedOption={selectedOption ?? null}
          onClearOption={onClearOption}
          isConnected={isConnected}
        />
      )}

      {/* ─── Perp Mode (existing) ─── */}
      {mode === "perp" && <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto">
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
            <div className="absolute h-[2px] bg-[var(--hl-accent)] rounded" style={{ top: "50%", transform: "translateY(-50%)", left: 0, width: `${sizePercent}%` }} />
            {/* Dot stops */}
            {[0, 25, 50, 75, 100].map(pct => (
              <button
                key={pct}
                onClick={() => handleSizeSlider(pct)}
                className="absolute w-2 h-2 rounded-full transition-colors -translate-x-1/2"
                style={{ left: `${pct}%`, backgroundColor: sizePercent >= pct ? "var(--hl-accent)" : "var(--hl-border)" }}
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
              className="absolute w-3.5 h-3.5 rounded-full border-2 border-[var(--hl-accent)] bg-[var(--background)] -translate-x-1/2 pointer-events-none"
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

        {/* Notional + margin display — always visible to prevent layout shift */}
        <div className="text-[10px] text-[var(--hl-muted)] space-y-0.5">
          <div className="flex justify-between">
            <span>Notional</span>
            <span className="text-[var(--foreground)] tabular-nums">${notional > 0 ? notional.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0.00"}</span>
          </div>
          <div className="flex justify-between">
            <span>Margin</span>
            <span className="text-[var(--foreground)] tabular-nums">${margin > 0 ? margin.toFixed(2) : "0.00"}</span>
          </div>
          <div className="flex justify-between">
            <span>Fees (0.035% + {BUILDER_FEE_DISPLAY})</span>
            <span className="text-[var(--foreground)] tabular-nums">${notional > 0 ? (notional * (0.00035 + BUILDER_FEE_PERCENT)).toFixed(2) : "0.00"}</span>
          </div>
        </div>

        {/* Reduce Only */}
        <label className="flex items-center gap-2 cursor-pointer">
          <div
            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              reduceOnly ? "bg-[var(--hl-accent)] border-[var(--hl-accent)]" : "border-[var(--hl-border)] bg-transparent"
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
                showTpSl ? "bg-[var(--hl-accent)] border-[var(--hl-accent)]" : "border-[var(--hl-border)] bg-transparent"
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
      </div>{/* end scrollable area */}

      {/* Submit button — pinned at bottom, never clipped */}
      <div className="px-3 py-3 shrink-0 border-t border-[var(--hl-border)]">
        <button
          className={`w-full py-2.5 rounded font-semibold text-[13px] transition-colors ${
            !isConnected
              ? "bg-[#0ea5e9] text-white hover:brightness-110"
              : sizeNum <= 0
                ? "bg-[var(--hl-surface)] text-[var(--hl-muted)] cursor-not-allowed"
                : "bg-[#0ea5e9] text-white hover:brightness-110"
          } ${submitting ? "opacity-50" : ""}`}
          disabled={submitting || (isConnected && sizeNum <= 0)}
          onClick={() => {
            if (!isConnected) {
              document.querySelector<HTMLButtonElement>('[data-testid="rk-connect-button"]')?.click();
            } else {
              handleSubmit();
            }
          }}
        >
          {submitting
            ? "Signing..."
            : !isConnected
              ? "Connect Wallet"
              : sizeNum <= 0
                ? `${side === "long" ? "Buy / Long" : "Sell / Short"}`
                : `${side === "long" ? "Buy / Long" : "Sell / Short"} ${displayCoin}`}
        </button>

        {/* Deposit / Withdraw buttons */}
        {isConnected && (
          <DepositWithdrawBar address={address!} />
        )}
      </div>
      </div>}

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
                className="w-full accent-[var(--hl-accent)]"
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
                className="w-[60px] px-2 py-1.5 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[13px] text-center text-[var(--foreground)] tabular-nums outline-none focus:border-[var(--hl-accent)]"
                autoFocus
              />
              <span className="text-[13px] text-[var(--hl-muted)]">x</span>
            </div>

            {/* Confirm button */}
            <button
              onClick={confirmLeverage}
              className="w-full mt-4 py-2.5 rounded font-semibold text-[13px] bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110 transition-colors"
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

// ─── Options Order Entry Panel (right side, mimics Derive) ──────────────────

interface OptionsOrderPanelProps {
  coin: string;
  selectedOption: SelectedOption | null;
  onClearOption?: () => void;
  isConnected: boolean;
}

function OptionsOrderPanel({ coin, selectedOption, onClearOption, isConnected }: OptionsOrderPanelProps) {
  const geo = useGeoCheck();
  const [optionSide, setOptionSide] = useState<"buy" | "sell">("buy");
  const [optOrderType, setOptOrderType] = useState<"limit" | "market">("limit");
  const [limitPrice, setLimitPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [orderResult, setOrderResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [deriveSubaccount, setDeriveSubaccount] = useState<number | null>(null);
  const [deriveBalance, setDeriveBalance] = useState<number | null>(null);
  const [deriveConnected, setDeriveConnected] = useState(false);
  const [setupStep, setSetupStep] = useState<"idle" | "creating" | "depositing" | "connecting">("idle");
  const [depositAmount, setDepositAmount] = useState("100");
  const [postOnly, setPostOnly] = useState(false);
  const [timeInForce, setTimeInForce] = useState<"gtc" | "ioc">("gtc");
  const { address } = useSafeAccount();

  // Poll Derive subaccount + balance — only runs when auth is already cached (no wallet prompts).
  // Auth gets cached when user explicitly clicks "Connect to Derive" or "Create Account".
  useEffect(() => {
    if (!isConnected || !address) return;
    let cancelled = false;

    const checkDerive = async () => {
      try {
        const derive = await import("@/lib/derive-exchange");
        // Only poll if we already have auth (user previously connected)
        if (!derive.hasCachedDeriveAuth(address)) return;
        if (!deriveConnected) setDeriveConnected(true);

        if (cancelled) return;
        const subs = await derive.getSubaccounts(address);
        if (cancelled) return;
        if (subs.length > 0) {
          const subId = subs[0].subaccountId;
          setDeriveSubaccount(subId);
          const bal = await derive.getUsdcBalance(address, subId);
          if (!cancelled) setDeriveBalance(bal);
        }
      } catch {}
    };

    checkDerive();
    const interval = setInterval(checkDerive, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isConnected, address, deriveConnected]);

  // Connect to Derive — signs auth with wallet (one MetaMask popup), then checks subaccounts
  const connectDerive = async () => {
    if (!address || setupStep !== "idle") return;
    setSetupStep("connecting");
    try {
      const [wagmiCore, derive, wagmiConfig] = await Promise.all([
        import("@wagmi/core"),
        import("@/lib/derive-exchange"),
        import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setSetupStep("idle"); return; }
      await derive.getDeriveAuth(walletClient, address as `0x${string}`);
      setDeriveConnected(true);
      // Immediately check for subaccount
      const subs = await derive.getSubaccounts(address);
      if (subs.length > 0) {
        const subId = subs[0].subaccountId;
        setDeriveSubaccount(subId);
        const bal = await derive.getUsdcBalance(address, subId);
        setDeriveBalance(bal);
      }
    } catch {
      setOrderResult({ ok: false, msg: "Failed to connect — try again" });
    } finally {
      setSetupStep("idle");
    }
  };

  // When a new option is selected from the chain, update the form
  useEffect(() => {
    if (selectedOption) {
      setOptionSide(selectedOption.side);
      setLimitPrice(selectedOption.price > 0 ? selectedOption.price.toFixed(2) : "");
      setAmount("");
      setOrderResult(null);
    }
  }, [selectedOption]);

  const opt = selectedOption;
  const typeLabel = opt?.type === "C" ? "Call" : "Put";
  const priceNum = parseFloat(limitPrice) || 0;
  const amountNum = parseFloat(amount) || 0;
  const premium = priceNum * amountNum;

  return (
    <div className="flex flex-col flex-1 px-3 mt-3 overflow-y-auto">
      {/* Option title */}
      {opt ? (
        <div className="mb-3">
          <div className="flex items-center justify-between">
            <div className="text-[12px] font-bold text-[var(--foreground)]">
              {coin} ${opt.strike.toLocaleString()} {typeLabel} {opt.expiry}
            </div>
            <button
              onClick={onClearOption}
              className="text-[var(--hl-muted)] hover:text-[var(--foreground)] transition-colors text-sm"
            >
              &times;
            </button>
          </div>
          <div className="text-[9px] text-purple-400 mt-0.5">via Derive</div>
        </div>
      ) : (
        <div className="flex items-center justify-center h-24 text-center">
          <div>
            <div className="text-[12px] text-[var(--hl-muted)] mb-1">Select an option</div>
            <div className="text-[10px] text-[var(--hl-muted)] opacity-60">Click a bid or ask in the chain</div>
          </div>
        </div>
      )}

      {opt && (
        <>
          {/* Buy / Sell toggle */}
          <div className="grid grid-cols-2 gap-px bg-[var(--hl-border)] rounded overflow-hidden mb-3">
            <button
              onClick={() => {
                setOptionSide("buy");
                setLimitPrice(opt.askPrice > 0 ? opt.askPrice.toFixed(2) : "");
              }}
              className={`py-2 text-[11px] font-semibold transition-colors ${
                optionSide === "buy"
                  ? "bg-[var(--hl-green)] text-[var(--background)]"
                  : "bg-[var(--hl-surface)] text-[var(--hl-muted)] hover:text-[var(--foreground)]"
              }`}
            >
              Buy {typeLabel}
            </button>
            <button
              onClick={() => {
                setOptionSide("sell");
                setLimitPrice(opt.bidPrice > 0 ? opt.bidPrice.toFixed(2) : "");
              }}
              className={`py-2 text-[11px] font-semibold transition-colors ${
                optionSide === "sell"
                  ? "bg-[var(--hl-red)] text-white"
                  : "bg-[var(--hl-surface)] text-[var(--hl-muted)] hover:text-[var(--foreground)]"
              }`}
            >
              Sell {typeLabel}
            </button>
          </div>

          {/* Order Type */}
          <div className="mb-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-[var(--hl-muted)]">Order Type</span>
              <select
                value={optOrderType}
                onChange={e => setOptOrderType(e.target.value as "limit" | "market")}
                className="text-[11px] bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-2 py-1 text-[var(--foreground)] outline-none"
              >
                <option value="limit">Limit</option>
                <option value="market">Market</option>
              </select>
            </div>
          </div>

          {/* Limit Price */}
          {optOrderType === "limit" && (
            <div className="mb-2.5">
              <div className="text-[10px] text-[var(--hl-muted)] mb-1">
                Limit Price
                {opt.bidPrice > 0 && (
                  <span className="text-[var(--hl-muted)] opacity-60 ml-1">Bid: ${opt.bidPrice.toFixed(2)}</span>
                )}
              </div>
              <div className="flex items-center bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-2 py-1.5">
                <span className="text-[11px] text-[var(--hl-muted)] mr-1">$</span>
                <input
                  type="number"
                  value={limitPrice}
                  onChange={e => setLimitPrice(e.target.value)}
                  placeholder="0.00"
                  step="0.01"
                  className="flex-1 bg-transparent text-right text-[13px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none font-medium"
                />
              </div>
            </div>
          )}

          {/* Amount */}
          <div className="mb-2.5">
            <div className="text-[10px] text-[var(--hl-muted)] mb-1">Amount</div>
            <div className="flex items-center bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-2 py-1.5">
              <input
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.0"
                step="0.1"
                className="flex-1 bg-transparent text-right text-[13px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none font-medium"
              />
            </div>
          </div>

          {/* Post Only + TIF */}
          <div className="flex items-center gap-4 mb-3 text-[10px]">
            <label className="flex items-center gap-1.5 text-[var(--hl-muted)] cursor-pointer">
              <input type="checkbox" checked={postOnly} onChange={e => setPostOnly(e.target.checked)} className="accent-purple-500 w-3 h-3" />
              Post Only
            </label>
            <select value={timeInForce} onChange={e => setTimeInForce(e.target.value as "gtc" | "ioc")} className="text-[10px] bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-1.5 py-0.5 text-[var(--foreground)] outline-none">
              <option value="gtc">GTC</option>
              <option value="ioc">IOC</option>
            </select>
          </div>

          {/* Execute button / Setup flow */}
          {geo.restricted ? (
            <div className="w-full py-2.5 rounded text-[11px] text-center bg-[var(--hl-surface)] text-[var(--hl-muted)] border border-[var(--hl-border)]">
              Options unavailable in your region
            </div>
          ) : !isConnected ? (
            <button
              disabled
              className="w-full py-2.5 rounded font-semibold text-[12px] bg-[var(--hl-surface)] text-[var(--hl-muted)] border border-[var(--hl-border)] cursor-not-allowed"
            >
              Connect Wallet
            </button>
          ) : !deriveConnected ? (
            /* ─── Not connected to Derive yet: prompt to connect ─── */
            <div className="space-y-2">
              <button
                onClick={connectDerive}
                disabled={setupStep === "connecting"}
                className="w-full py-2.5 rounded font-semibold text-[12px] text-center transition-colors bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30 disabled:opacity-50"
              >
                {setupStep === "connecting" ? "Connecting..." : "Connect to Derive"}
              </button>
              <p className="text-[9px] text-[var(--hl-muted)] text-center">Sign to check your Derive options account</p>
            </div>
          ) : deriveSubaccount === null ? (
            /* ─── Connected but no Derive account: link to onboard ─── */
            <div className="space-y-3">
              <div className="text-center">
                <div className="text-[11px] text-[var(--hl-muted)] mb-2">No Derive account found for this wallet</div>
                <a
                  href="https://derive.xyz/options/ETH"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block w-full py-2.5 rounded font-semibold text-[12px] text-center transition-colors bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30"
                >
                  Set Up on Derive
                </a>
                <p className="text-[9px] text-[var(--hl-muted)] mt-2">Create your account and deposit USDC on derive.xyz, then return here to trade</p>
              </div>
              <button
                onClick={connectDerive}
                disabled={setupStep === "connecting"}
                className="w-full py-1.5 rounded text-[10px] text-center transition-colors text-[var(--hl-muted)] hover:text-[var(--foreground)] border border-[var(--hl-border)] hover:border-[var(--hl-accent)]"
              >
                {setupStep === "connecting" ? "Checking..." : "Re-check Account"}
              </button>
            </div>
          ) : (
            /* ─── Has account: show balance + trade or deposit ─── */
            <div className="space-y-2">
              {/* Balance display */}
              {deriveBalance !== null && (
                <div className="flex items-center justify-between text-[10px] mb-1">
                  <span className="text-[var(--hl-muted)]">Derive Balance</span>
                  <span className="tabular-nums text-[var(--foreground)] font-medium">${deriveBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                </div>
              )}
              {/* Deposit more (collapsible) */}
              {setupStep === "depositing" ? (
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] text-[var(--hl-muted)]">$</span>
                  <input
                    type="number"
                    value={depositAmount}
                    onChange={e => setDepositAmount(e.target.value)}
                    placeholder="100"
                    className="flex-1 bg-transparent text-right text-[11px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none border-b border-[var(--hl-border)]"
                    autoFocus
                  />
                  <button
                    onClick={async () => {
                      if (!address || !deriveSubaccount || submitting) return;
                      setSubmitting(true);
                      setOrderResult(null);
                      try {
                        const [wagmiCore, derive, wagmiConfig] = await Promise.all([
                          import("@wagmi/core"),
                          import("@/lib/derive-exchange"),
                          import("@/config/wagmi"),
                        ]);
                        const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
                        if (!walletClient) { setSubmitting(false); return; }
                        const res = await derive.depositToSubaccount(walletClient, address as `0x${string}`, {
                          subaccountId: deriveSubaccount,
                          amount: depositAmount || "100",
                        });
                        if (res.success) {
                          setDeriveBalance(prev => (prev ?? 0) + parseFloat(depositAmount || "100"));
                          setOrderResult({ ok: true, msg: `Deposited $${depositAmount}` });
                          setSetupStep("idle");
                        } else {
                          setOrderResult({ ok: false, msg: res.error || "Deposit failed" });
                        }
                      } catch (err) {
                        setOrderResult({ ok: false, msg: (err as Error).message || "Failed" });
                      } finally {
                        setSubmitting(false);
                      }
                    }}
                    disabled={submitting}
                    className="px-2 py-1 text-[10px] font-semibold rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30 disabled:opacity-50"
                  >
                    {submitting ? "..." : "Deposit"}
                  </button>
                  <button
                    onClick={() => setSetupStep("idle")}
                    className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-sm"
                  >&times;</button>
                </div>
              ) : (
                <button
                  onClick={() => setSetupStep("depositing")}
                  className="text-[9px] text-purple-400 hover:text-purple-300 transition-colors"
                >
                  + Deposit USDC
                </button>
              )}
              {/* Trade button */}
              <button
                onClick={async () => {
                  if (!opt || !address || submitting || deriveSubaccount === null) return;
                  setSubmitting(true);
                  setOrderResult(null);
                  try {
                    const [wagmiCore, derive, wagmiConfig] = await Promise.all([
                      import("@wagmi/core"),
                      import("@/lib/derive-exchange"),
                      import("@/config/wagmi"),
                    ]);
                    const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
                    if (!walletClient) { setSubmitting(false); return; }

                    const result = await derive.placeOrder(walletClient, address as `0x${string}`, {
                      instrumentName: opt.instrument,
                      direction: optionSide,
                      amount: amount || "1",
                      limitPrice: optOrderType === "market"
                        ? (optionSide === "buy" ? (opt.askPrice * 1.05).toFixed(2) : (opt.bidPrice * 0.95).toFixed(2))
                        : limitPrice,
                      maxFee: "10",
                      subaccountId: deriveSubaccount,
                      timeInForce: postOnly ? "post_only" : timeInForce,
                      orderType: optOrderType,
                      label: "hlone",
                    });

                    setOrderResult({
                      ok: result.success,
                      msg: result.success ? `Order placed${result.orderId ? ` #${result.orderId}` : ""}` : (result.error || "Order failed"),
                    });
                  } catch (err) {
                    setOrderResult({ ok: false, msg: (err as Error).message || "Unknown error" });
                  } finally {
                    setSubmitting(false);
                  }
                }}
                disabled={submitting || (!limitPrice && optOrderType === "limit") || !amount}
                className={`w-full py-2.5 rounded font-semibold text-[12px] transition-colors disabled:opacity-50 ${
                  optionSide === "buy"
                    ? "bg-[var(--hl-green)] text-white hover:brightness-110"
                    : "bg-[var(--hl-red)] text-white hover:brightness-110"
                }`}
              >
                {submitting ? "Signing..." : `${optionSide === "buy" ? "Buy" : "Sell"} ${typeLabel}`}
              </button>
            </div>
          )}

          {/* Order result */}
          {orderResult && (
            <div className={`mt-2 text-[10px] text-center ${orderResult.ok ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}`}>
              {orderResult.msg}
            </div>
          )}

          {/* Order summary */}
          <div className="mt-3 space-y-1.5 text-[10px]">
            <div className="flex justify-between">
              <span className="text-[var(--hl-muted)]">{optionSide === "buy" ? "Max Cost" : "Min Received"}</span>
              <span className="text-[var(--foreground)] tabular-nums font-medium">${premium > 0 ? premium.toFixed(2) : "0.00"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--hl-muted)]">Margin Required</span>
              <span className="text-[var(--foreground)] tabular-nums">$0.00</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--hl-muted)]">Est. Fee</span>
              <span className="text-[var(--foreground)] tabular-nums">${(premium * 0.0003).toFixed(4)}</span>
            </div>
          </div>

          {/* Greeks / details tabs */}
          <div className="mt-3 pt-3 border-t border-[var(--hl-border)]">
            <div className="grid grid-cols-4 gap-x-2 gap-y-1.5 text-[9px]">
              <div>
                <div className="text-[var(--hl-muted)]">IV</div>
                <div className="text-[var(--foreground)] tabular-nums font-medium">{opt.iv.toFixed(1)}%</div>
              </div>
              <div>
                <div className="text-[var(--hl-muted)]">Delta</div>
                <div className="text-[var(--foreground)] tabular-nums font-medium">{opt.delta.toFixed(3)}</div>
              </div>
              <div>
                <div className="text-[var(--hl-muted)]">Gamma</div>
                <div className="text-[var(--foreground)] tabular-nums font-medium">{opt.gamma.toFixed(4)}</div>
              </div>
              <div>
                <div className="text-[var(--hl-muted)]">Theta</div>
                <div className="text-[var(--foreground)] tabular-nums font-medium">{opt.theta.toFixed(3)}</div>
              </div>
              <div>
                <div className="text-[var(--hl-muted)]">Vega</div>
                <div className="text-[var(--foreground)] tabular-nums font-medium">{opt.vega.toFixed(3)}</div>
              </div>
              <div>
                <div className="text-[var(--hl-muted)]">Mark</div>
                <div className="text-[var(--foreground)] tabular-nums font-medium">${opt.markPrice.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-[var(--hl-muted)]">Bid</div>
                <div className="text-[var(--hl-green)] tabular-nums font-medium">${opt.bidPrice.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-[var(--hl-muted)]">Ask</div>
                <div className="text-[var(--hl-red)] tabular-nums font-medium">${opt.askPrice.toFixed(2)}</div>
              </div>
            </div>
          </div>

          {/* OI */}
          <div className="mt-2 text-[9px] flex justify-between">
            <span className="text-[var(--hl-muted)]">Open Interest</span>
            <span className="text-[var(--foreground)] tabular-nums">{opt.openInterest.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Deposit / Withdraw Bar ─────────────────────────────────────────────────

function DepositWithdrawBar({ address }: { address: string }) {
  const [mode, setMode] = useState<"none" | "deposit" | "withdraw">("none");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [spotBalance, setSpotBalance] = useState<number | null>(null);
  const [perpsBalance, setPerpsBalance] = useState<number | null>(null);

  // Fetch both balances
  useEffect(() => {
    if (!address) return;
    const fetchBalances = async () => {
      try {
        // Perps balance (withdrawable)
        const perpsRes = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: address }),
        });
        const perpsData = await perpsRes.json();
        setPerpsBalance(parseFloat(perpsData?.withdrawable ?? "0"));
      } catch { /* ignore */ }
      try {
        // Spot balance (USDC = token index 0 in spot)
        const spotRes = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "spotClearinghouseState", user: address }),
        });
        const spotData = await spotRes.json();
        const usdcBal = spotData?.balances?.find((b: { coin: string; total: string }) => b.coin === "USDC");
        setSpotBalance(usdcBal ? parseFloat(usdcBal.total) : 0);
      } catch { setSpotBalance(0); }
    };
    fetchBalances();
    const iv = window.setInterval(fetchBalances, 30_000);
    return () => clearInterval(iv);
  }, [address]);

  // Transfer: deposit = spot→perp, withdraw = perp→spot
  const handleTransfer = useCallback(async (toPerp: boolean) => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      const [wagmiCore, exchange, wagmiConfig] = await Promise.all([
        import("@wagmi/core"),
        import("@/lib/hl-exchange"),
        import("@/config/wagmi"),
      ]);
      const walletClient = await wagmiCore.getWalletClient(wagmiConfig.config);
      if (!walletClient) { setResult({ ok: false, msg: "No wallet" }); return; }
      const res = await exchange.transferBetweenSpotAndPerp(walletClient, address as `0x${string}`, amt, toPerp);
      setResult(res.success
        ? { ok: true, msg: `Transferred $${amt} ${toPerp ? "Spot → Perps" : "Perps → Spot"}` }
        : { ok: false, msg: res.error || "Failed" }
      );
      if (res.success) setAmount("");
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : "Failed" });
    } finally {
      setSubmitting(false);
    }
  }, [amount, address]);

  if (mode === "none") {
    const fmtBal = (v: number | null) => v === null ? "..." : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    return (
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => { setMode("deposit"); setResult(null); }}
          className="flex-1 py-1.5 rounded text-[10px] font-medium border border-[var(--hl-border)] bg-[var(--hl-surface)] text-[var(--hl-green)] hover:bg-[var(--hl-surface-hover)] transition-colors"
        >
          <div>Spot → Perps</div>
          <div className="text-[9px] text-[var(--hl-muted)] mt-0.5">{fmtBal(spotBalance)} available</div>
        </button>
        <button
          onClick={() => { setMode("withdraw"); setResult(null); }}
          className="flex-1 py-1.5 rounded text-[10px] font-medium border border-[var(--hl-border)] bg-[var(--hl-surface)] text-[var(--hl-accent)] hover:bg-[var(--hl-surface-hover)] transition-colors"
        >
          <div>Perps → Spot</div>
          <div className="text-[9px] text-[var(--hl-muted)] mt-0.5">{fmtBal(perpsBalance)} available</div>
        </button>
      </div>
    );
  }

  const toPerp = mode === "deposit";

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={() => { setMode("none"); setResult(null); setAmount(""); }} className="text-[var(--hl-muted)] hover:text-[var(--foreground)] text-[14px]">&larr;</button>
        <span className="text-[11px] font-medium text-[var(--foreground)]">{toPerp ? "Spot → Perps" : "Perps → Spot"}</span>
        <span className="text-[9px] text-[var(--hl-muted)] ml-auto tabular-nums">
          {toPerp
            ? `Spot: $${(spotBalance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            : `Perps: $${(perpsBalance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
          }
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded px-2 py-1.5">
          <span className="text-[10px] text-[var(--hl-muted)] mr-1">$</span>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-right text-[12px] text-[var(--foreground)] tabular-nums placeholder:text-[var(--hl-muted)] outline-none"
            autoFocus
          />
          <button
            onClick={() => setAmount(String(toPerp ? (spotBalance ?? 0) : (perpsBalance ?? 0)))}
            className="text-[9px] text-[var(--hl-accent)] ml-1 hover:brightness-110"
          >
            MAX
          </button>
        </div>
        <button
          onClick={() => handleTransfer(toPerp)}
          disabled={submitting || !parseFloat(amount)}
          className={`px-4 py-1.5 rounded text-[11px] font-semibold transition-colors bg-[var(--hl-accent)] text-[var(--background)] ${submitting || !parseFloat(amount) ? "opacity-40" : "hover:brightness-110"}`}
        >
          {submitting ? "..." : "Transfer"}
        </button>
      </div>
      <div className="text-[9px] text-[var(--hl-muted)]">
        Transfer USDC between your {toPerp ? "Spot" : "Perps"} and {toPerp ? "Perps" : "Spot"} wallet on Hyperliquid.
      </div>
      {result && (
        <div className={`text-[10px] rounded p-1.5 ${result.ok ? "text-[var(--hl-green)] bg-[rgba(80,210,193,0.08)]" : "text-[var(--hl-red)] bg-[rgba(240,88,88,0.08)]"}`}>
          {result.msg}
        </div>
      )}
    </div>
  );
}
