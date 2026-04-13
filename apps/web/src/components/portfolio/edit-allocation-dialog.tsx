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
import { updateAllocation } from "@/lib/api";
import { useSignMessage } from "wagmi";
import { useAccount } from "wagmi";

interface EditAllocationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  copyRelationshipId: string;
  onSaved: () => void;
}

export function EditAllocationDialog({
  open,
  onOpenChange,
  copyRelationshipId,
  onSaved,
}: EditAllocationDialogProps) {
  const [capital, setCapital] = useState("");
  const [maxLeverage, setMaxLeverage] = useState(10);
  const [maxPositionPct, setMaxPositionPct] = useState(25);
  const [submitting, setSubmitting] = useState(false);
  const { signMessageAsync } = useSignMessage();
  const { address } = useAccount();

  const handleSave = async () => {
    if (!address) return;
    setSubmitting(true);
    try {
      await updateAllocation({
        walletAddress: address,
        copyRelationshipId,
        ...(capital ? { allocatedCapital: parseFloat(capital) } : {}),
        maxLeverage,
        maxPositionSizePercent: maxPositionPct,
      }, signMessageAsync);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to update allocation", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Allocation</DialogTitle>
          <DialogDescription>
            Update capital and risk settings for this copy relationship
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Allocated Capital ($)</Label>
            <Input
              type="number"
              value={capital}
              onChange={(e) => setCapital(e.target.value)}
              placeholder="Leave blank to keep current"
            />
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
            <Label>Max Position Size ({maxPositionPct}%)</Label>
            <Slider
              min={5}
              max={100}
              step={5}
              value={[maxPositionPct]}
              onValueChange={([val]) => setMaxPositionPct(val)}
            />
          </div>

          <Button className="w-full" onClick={handleSave} disabled={submitting}>
            {submitting ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
