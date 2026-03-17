"use client";

import { useState, useEffect } from "react";
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
import { useSignTypedData } from "wagmi";

interface CopyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  traderAddress: string;
  walletAddress: string | undefined;
}

export function CopyDialog({
  open,
  onOpenChange,
  traderAddress,
  walletAddress,
}: CopyDialogProps) {
  const [capital, setCapital] = useState("1000");
  const [maxLeverage, setMaxLeverage] = useState(10);
  const [maxPositionPct, setMaxPositionPct] = useState(25);
  const [minOrder, setMinOrder] = useState("10");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [builderFee, setBuilderFee] = useState<BuilderFeeInfo | null>(null);
  const [feeApproved, setFeeApproved] = useState<boolean | null>(null);
  const [approvingFee, setApprovingFee] = useState(false);
  const { signTypedDataAsync } = useSignTypedData();

  useEffect(() => {
    if (open && walletAddress) {
      getBuilderFee().then(setBuilderFee).catch(() => {});
      checkBuilderApproval(walletAddress).then((r) => setFeeApproved(r.approved)).catch(() => {});
    }
  }, [open, walletAddress]);

  const handleApproveFee = async () => {
    if (!walletAddress || !builderFee) return;
    setApprovingFee(true);
    try {
      // Sign the ApproveBuilderFee action via Hyperliquid's exchange endpoint
      const nonce = Date.now();
      const action = {
        type: "approveBuilderFee",
        hyperliquidChain: "Mainnet",
        maxFeeRate: (builderFee.fee / 10 / 100 / 100).toString(), // Convert tenths of bps to decimal
        builder: builderFee.builder,
        nonce,
      };

      const signature = await signTypedDataAsync({
        domain: {
          name: "Exchange",
          version: "1",
          chainId: 1337,
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        types: {
          "HyperliquidTransaction:ApproveBuilderFee": [
            { name: "hyperliquidChain", type: "string" },
            { name: "maxFeeRate", type: "string" },
            { name: "builder", type: "address" },
            { name: "nonce", type: "uint64" },
          ],
        },
        primaryType: "HyperliquidTransaction:ApproveBuilderFee",
        message: {
          hyperliquidChain: "Mainnet",
          maxFeeRate: (builderFee.fee / 10 / 100 / 100).toString(),
          builder: builderFee.builder as `0x${string}`,
          nonce: BigInt(nonce),
        },
      });

      // Submit to Hyperliquid exchange
      const res = await fetch("https://api.hyperliquid.xyz/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, nonce, signature }),
      });
      const data = await res.json();
      if (data.status === "ok") {
        setFeeApproved(true);
      } else {
        setResult(`Fee approval failed: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      setResult(`Fee approval error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setApprovingFee(false);
    }
  };

  const handleSubmit = async () => {
    if (!walletAddress) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await startCopy({
        walletAddress,
        traderAddress,
        allocatedCapital: parseFloat(capital),
        maxLeverage,
        maxPositionSizePercent: maxPositionPct,
        minOrderSize: parseFloat(minOrder),
      });
      setResult(`Copy ${res.status}! Relationship ID: ${res.id.slice(0, 8)}...`);
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy Trader</DialogTitle>
          <DialogDescription>
            Configure how to copy {shortenAddress(traderAddress, 6)}
          </DialogDescription>
        </DialogHeader>

        {!walletAddress ? (
          <p className="text-sm text-yellow-400">Connect your wallet first to start copying.</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Allocated Capital ($)</Label>
              <Input
                type="number"
                value={capital}
                onChange={(e) => setCapital(e.target.value)}
                placeholder="1000"
              />
              <p className="text-xs text-[var(--hl-muted)]">
                Amount of your capital to allocate to this trader
              </p>
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

            <Button className="w-full" onClick={handleSubmit} disabled={submitting || (builderFee?.builder ? feeApproved === false : false)}>
              {submitting ? "Starting..." : "Start Copying"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
