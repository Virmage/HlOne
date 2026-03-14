"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { formatUsd } from "@/lib/utils";

interface EquityCurveProps {
  data: {
    time: string;
    value: string | null;
    pnl: string | null;
    drawdown: number | null;
  }[];
}

export function EquityCurve({ data }: EquityCurveProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500 text-sm">
        No equity curve data available
      </div>
    );
  }

  const chartData = data.map((d) => ({
    time: new Date(d.time).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    value: parseFloat(d.value || "0"),
    pnl: parseFloat(d.pnl || "0"),
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
        <defs>
          <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="time"
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 10, fill: "#71717a" }}
          interval="preserveStartEnd"
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 10, fill: "#71717a" }}
          tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
          width={50}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#18181b",
            border: "1px solid #3f3f46",
            borderRadius: "8px",
            fontSize: "12px",
          }}
          labelStyle={{ color: "#a1a1aa" }}
          formatter={(value: number) => [formatUsd(value), "Value"]}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="#10b981"
          strokeWidth={2}
          fill="url(#equityGradient)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
