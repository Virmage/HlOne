"use client";

import { useState } from "react";
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
import { startCopy } from "@/lib/api";

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
              <p className="text-xs text-zinc-500">
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
              <p className="text-xs text-zinc-500">
                Orders below this size will be skipped
              </p>
            </div>

            {result && (
              <p className={`text-sm ${result.startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>
                {result}
              </p>
            )}

            <Button className="w-full" onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Starting..." : "Start Copying"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
