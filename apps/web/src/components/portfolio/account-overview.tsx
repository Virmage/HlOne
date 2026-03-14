"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUsd, pnlColor } from "@/lib/utils";
import type { PortfolioOverview } from "@/lib/api";

interface AccountOverviewProps {
  overview: PortfolioOverview | null;
}

export function AccountOverview({ overview }: AccountOverviewProps) {
  if (!overview) {
    return (
      <Card>
        <CardContent className="flex h-32 items-center justify-center text-zinc-500">
          Connect your wallet to see your portfolio
        </CardContent>
      </Card>
    );
  }

  const stats = [
    { label: "Wallet Balance", value: formatUsd(overview.walletBalance) },
    { label: "Available Margin", value: formatUsd(overview.availableMargin) },
    { label: "Allocated Capital", value: formatUsd(overview.allocatedCapital) },
    {
      label: "Unrealized PnL",
      value: formatUsd(overview.unrealizedPnl),
      color: pnlColor(overview.unrealizedPnl),
    },
    {
      label: "Realized PnL",
      value: formatUsd(overview.realizedPnl),
      color: pnlColor(overview.realizedPnl),
    },
    {
      label: "Idle Capital",
      value: formatUsd(overview.idleCapital),
      color: overview.idleCapital > 100 ? "text-yellow-400" : undefined,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Account Overview</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {stats.map((stat) => (
            <div key={stat.label}>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {stat.label}
              </p>
              <p className={`mt-0.5 text-lg font-semibold ${stat.color || "text-zinc-200"}`}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
