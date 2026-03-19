"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import type { WhaleAlert } from "@/lib/api";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface TokenChartProps {
  candles: Candle[];
  whaleAlerts?: WhaleAlert[];
}

export function TokenChart({ candles, whaleAlerts = [] }: TokenChartProps) {
  if (!candles.length) {
    return (
      <div className="h-48 flex items-center justify-center text-[var(--hl-muted)] text-[12px]">
        No chart data
      </div>
    );
  }

  // Use close prices for area chart
  const data = candles.map(c => ({
    time: c.time,
    price: c.close,
    label: new Date(c.time).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  }));

  const firstPrice = data[0].price;
  const lastPrice = data[data.length - 1].price;
  const isUp = lastPrice >= firstPrice;
  const color = isUp ? "var(--hl-green)" : "var(--hl-red)";

  // Find whale alert timestamps that fall within chart range
  const chartStart = candles[0].time;
  const chartEnd = candles[candles.length - 1].time;
  const relevantAlerts = whaleAlerts.filter(
    a => a.detectedAt >= chartStart && a.detectedAt <= chartEnd
  );

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="tokenGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.15} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--hl-muted)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={["auto", "auto"]}
            tick={{ fill: "var(--hl-muted)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={50}
            tickFormatter={(v) => `$${v >= 1 ? v.toLocaleString() : v.toPrecision(3)}`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--hl-surface)",
              border: "1px solid var(--hl-border)",
              borderRadius: "6px",
              fontSize: "11px",
              color: "var(--hl-text)",
            }}
            formatter={(value) => [`$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`, "Price"]}
            labelFormatter={(label) => label}
          />
          {/* Whale alert reference lines */}
          {relevantAlerts.map((alert, i) => {
            // Find closest candle to alert time
            const closest = data.reduce((prev, curr) =>
              Math.abs(curr.time - alert.detectedAt) < Math.abs(prev.time - alert.detectedAt) ? curr : prev
            );
            const isLong = alert.eventType.includes("long") || alert.eventType === "increase";
            return (
              <ReferenceLine
                key={i}
                x={closest.label}
                stroke={isLong ? "var(--hl-green)" : "var(--hl-red)"}
                strokeDasharray="3 3"
                strokeOpacity={0.6}
              />
            );
          })}
          <Area
            type="monotone"
            dataKey="price"
            stroke={color}
            strokeWidth={1.5}
            fill="url(#tokenGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
