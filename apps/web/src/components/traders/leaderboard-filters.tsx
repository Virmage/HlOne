"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { TraderFilters } from "@/lib/api";

interface LeaderboardFiltersProps {
  filters: TraderFilters;
  onApply: (filters: TraderFilters) => void;
}

export function LeaderboardFilters({ filters, onApply }: LeaderboardFiltersProps) {
  const [local, setLocal] = useState<TraderFilters>(filters);
  const [expanded, setExpanded] = useState(false);

  const handleApply = () => onApply(local);
  const handleReset = () => {
    const reset: TraderFilters = {};
    setLocal(reset);
    onApply(reset);
  };

  return (
    <div className="rounded-lg border border-[var(--hl-border)] bg-[var(--hl-surface)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[var(--hl-text)]">Filters</h3>
        <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </div>

      {expanded && (
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          <div className="space-y-2">
            <Label>Min Account Size ($)</Label>
            <Input
              type="number"
              placeholder="e.g. 10000"
              value={local.minAccountSize || ""}
              onChange={(e) => setLocal({ ...local, minAccountSize: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>Min ROI (%)</Label>
            <Input
              type="number"
              placeholder="e.g. 50"
              value={local.minRoi || ""}
              onChange={(e) => setLocal({ ...local, minRoi: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>Min PnL ($)</Label>
            <Input
              type="number"
              placeholder="e.g. 5000"
              value={local.minPnl || ""}
              onChange={(e) => setLocal({ ...local, minPnl: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>Min Trades</Label>
            <Input
              type="number"
              placeholder="e.g. 100"
              value={local.minTrades || ""}
              onChange={(e) => setLocal({ ...local, minTrades: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>Max Leverage</Label>
            <div className="pt-2">
              <Slider
                min={1}
                max={50}
                step={1}
                value={[parseInt(local.maxLeverage || "50")]}
                onValueChange={([val]) => setLocal({ ...local, maxLeverage: val.toString() })}
              />
              <span className="mt-1 block text-xs text-[var(--hl-muted)]">
                {local.maxLeverage || "50"}x
              </span>
            </div>
          </div>

          <div className="col-span-full flex items-center gap-2">
            <Button size="sm" onClick={handleApply}>Apply Filters</Button>
            <Button size="sm" variant="outline" onClick={handleReset}>Reset</Button>
          </div>
        </div>
      )}
    </div>
  );
}
