"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { shortenAddress } from "@/lib/utils";
import { startCopy, getBuilderFee, checkBuilderApproval, type BuilderFeeInfo } from "@/lib/api";
import { useAccount, useSignMessage } from "wagmi";
import { approveBuilderFee as hlApproveBuilderFee } from "@/lib/hl-exchange";
import { getWalletClient } from "@wagmi/core";
import { config } from "@/config/wagmi";

interface CopyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  traderAddress: string;
  walletAddress: string | undefined;
}

interface AccountBalance {
  accountValue: number;
  totalMarginUsed: number;
  withdrawable: number;
}

async function fetchAccountBalance(address: string): Promise<AccountBalance | null> {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address }),
    });
    const data = await res.json();
    const summary = data?.crossMarginSummary;
    if (!summary) return null;
    return {
      accountValue: parseFloat(summary.accountValue || "0"),
      totalMarginUsed: parseFloat(summary.totalMarginUsed || "0"),
      withdrawable: parseFloat(summary.withdrawable || "0"),
    };
  } catch {
    return null;
  }
}

function formatUsd(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export function CopyDialog({
  open,
  onOpenChange,
  traderAddress,
  walletAddress,
}: CopyDialogProps) {
  const [capital, setCapital] = useState("");
  const [maxLeverage, setMaxLeverage] = useState(10);
  const [maxPositionPct, setMaxPositionPct] = useState(25);
  const [minOrder, setMinOrder] = useState("10");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [builderFee, setBuilderFee] = useState<BuilderFeeInfo | null>(null);
  const [feeApproved, setFeeApproved] = useState<boolean | null>(null);
  const [approvingFee, setApprovingFee] = useState(false);
  const [balance, setBalance] = useState<AccountBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const { connector } = useAccount();
  const { signMessageAsync } = useSignMessage();

  useEffect(() => {
    if (open && walletAddress) {
      getBuilderFee().then(setBuilderFee).catch(() => {});
      checkBuilderApproval(walletAddress).then((r) => setFeeApproved(r.approved)).catch(() => {});
      setBalanceLoading(true);
      fetchAccountBalance(walletAddress)
        .then((b) => setBalance(b))
        .finally(() => setBalanceLoading(false));
    }
    if (!open) {
      setResult(null);
      setBalance(null);
    }
  }, [open, walletAddress]);

  // Set default capital to 10% of account value when balance loads
  useEffect(() => {
    if (balance && !capital) {
      const suggested = Math.floor(balance.accountValue * 0.1);
      if (suggested >= 10) setCapital(String(suggested));
    }
  }, [balance, capital]);

  const capitalNum = parseFloat(capital) || 0;
  const availableBalance = balance?.withdrawable ?? balance?.accountValue ?? 0;

  const capitalError = useMemo(() => {
    if (!capital || capitalNum === 0) return null;
    if (capitalNum < 10) return "Minimum allocation is $10";
    if (balance && capitalNum > balance.accountValue) return "Exceeds your account value";
    if (capitalNum > 10_000_000) return "Maximum allocation is $10M";
    return null;
  }, [capital, capitalNum, balance]);

  const canSubmit = capitalNum >= 10 && !capitalError && !submitting &&
    !(builderFee?.builder && feeApproved === false);

  const handleApproveFee = async () => {
    if (!walletAddress || !builderFee) return;
    setApprovingFee(true);
    try {
      const walletClient = await getWalletClient(config);
      if (!walletClient) throw new Error("Wallet not connected");

      const result = await hlApproveBuilderFee(walletClient, walletAddress as `0x${string}`);
      if (result.success) {
        setFeeApproved(true);
      } else {
        setResult(`Fee approval failed: ${result.error}`);
      }
    } catch (err) {
      setResult(`Fee approval error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setApprovingFee(false);
    }
  };

  const handleSubmit = async () => {
    if (!walletAddress || !canSubmit) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await startCopy({
        walletAddress,
        traderAddress,
        allocatedCapital: capitalNum,
        maxLeverage,
        maxPositionSizePercent: maxPositionPct,
        minOrderSize: parseFloat(minOrder) || 10,
      }, signMessageAsync);
      setResult(`Copy ${res.status}! Relationship ID: ${res.id.slice(0, 8)}...`);
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setSubmitting(false);
    }
  };

  const capitalPctOfAccount = balance && capitalNum > 0
    ? ((capitalNum / balance.accountValue) * 100).toFixed(1)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy Trader</DialogTitle>
          <DialogDescription>
            Configure how to copy {shortenAddress(traderAddress, 6)}
          </DialogDescription>
        </DialogHeader>

        {/* Important callout */}
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
          <p className="text-[11px] text-yellow-400 font-medium">
            Copy trading will mirror all <span className="font-bold">new trades from now on</span>. It will not copy any existing or previous positions held by this trader.
          </p>
        </div>

        {!walletAddress ? (
          <p className="text-sm text-yellow-400">Connect your wallet first to start copying.</p>
        ) : (
          <div className="space-y-4">
            {/* Account Balance Card */}
            <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-3">
              <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wider mb-1.5">Your Account</div>
              {balanceLoading ? (
                <div className="text-[11px] text-[var(--hl-muted)]">Loading balance...</div>
              ) : balance ? (
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className="text-[10px] text-[var(--hl-muted)]">Account Value</div>
                    <div className="text-[13px] font-semibold text-[var(--foreground)] tabular-nums">
                      {formatUsd(balance.accountValue)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[var(--hl-muted)]">Margin Used</div>
                    <div className="text-[13px] font-semibold text-[var(--foreground)] tabular-nums">
                      {formatUsd(balance.totalMarginUsed)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[var(--hl-muted)]">Withdrawable</div>
                    <div className="text-[13px] font-semibold text-[var(--hl-green)] tabular-nums">
                      {formatUsd(balance.withdrawable)}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-[11px] text-[var(--hl-muted)]">
                  Could not load balance. You can still set an allocation manually.
                </div>
              )}
            </div>

            {/* Capital Allocation */}
            <div className="space-y-2">
              <Label>Allocated Capital ($)</Label>
              <div className="relative">
                <Input
                  type="number"
                  value={capital}
                  onChange={(e) => setCapital(e.target.value)}
                  placeholder={balance ? `e.g. ${Math.floor(balance.accountValue * 0.1)}` : "1000"}
                  className={capitalError ? "border-red-500/50" : ""}
                />
                {capitalPctOfAccount && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[var(--hl-muted)] tabular-nums pointer-events-none">
                    {capitalPctOfAccount}% of account
                  </span>
                )}
              </div>
              {capitalError ? (
                <p className="text-xs text-red-400">{capitalError}</p>
              ) : (
                <p className="text-xs text-[var(--hl-muted)]">
                  Amount to allocate for copying this trader's positions
                </p>
              )}
              {/* Quick allocation buttons */}
              {balance && balance.accountValue >= 100 && (
                <div className="flex gap-1.5">
                  {[5, 10, 25, 50].map((pct) => {
                    const amt = Math.floor(balance.accountValue * pct / 100);
                    return (
                      <button
                        key={pct}
                        onClick={() => setCapital(String(amt))}
                        className="px-2 py-0.5 text-[10px] rounded border border-[var(--hl-border)] text-[var(--hl-muted)] hover:text-[var(--foreground)] hover:border-[var(--hl-accent)] transition-colors"
                      >
                        {pct}%
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Max Leverage ({maxLeverage}x)</Label>
              <Slider
                min={1}
                max={50}
                step={1}
                value={[maxLeverage]}
                onValueChange={([val]) => setMaxLeverage(val)}
              />
            </div>

            <div className="space-y-2">
              <Label>Max Position Size ({maxPositionPct}% of allocation)</Label>
              <Slider
                min={5}
                max={100}
                step={5}
                value={[maxPositionPct]}
                onValueChange={([val]) => setMaxPositionPct(val)}
              />
            </div>

            <div className="space-y-2">
              <Label>Min Order Size ($)</Label>
              <Input
                type="number"
                value={minOrder}
                onChange={(e) => setMinOrder(e.target.value)}
                placeholder="10"
              />
              <p className="text-xs text-[var(--hl-muted)]">
                Orders below this size will be skipped
              </p>
            </div>

            {/* Builder Fee Info & Approval */}
            {builderFee && builderFee.builder && (
              <div className="rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-3 space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--hl-muted)]">Platform Fee</span>
                  <span className="text-[var(--hl-text)]">{builderFee.feeDisplay}</span>
                </div>
                {feeApproved === false && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={handleApproveFee}
                    disabled={approvingFee}
                  >
                    {approvingFee ? "Approving..." : "Approve Platform Fee (one-time)"}
                  </Button>
                )}
                {feeApproved === true && (
                  <p className="text-xs text-[var(--hl-green)]">Fee approved</p>
                )}
              </div>
            )}

            {result && (
              <p className={`text-sm ${result.startsWith("Error") || result.startsWith("Fee") ? "text-red-400" : "text-[var(--hl-green)]"}`}>
                {result}
              </p>
            )}

            <Button
              className="w-full bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {submitting ? "Starting..." : `Start Copying${capitalNum > 0 ? ` — ${formatUsd(capitalNum)}` : ""}`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
