"use client";
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, Legend,
  CartesianGrid,
} from "recharts";
import type { RevenueTrendPoint } from "@/server/analytics/service";

export function RevenueChart({ data }: { data: RevenueTrendPoint[] }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="day" tick={{ fontSize: 12 }} stroke="currentColor" className="text-muted-foreground" />
          <YAxis yAxisId="revenue" tick={{ fontSize: 12 }} stroke="currentColor" className="text-muted-foreground" />
          <YAxis yAxisId="count" orientation="right" tick={{ fontSize: 12 }} stroke="currentColor" className="text-muted-foreground" />
          <Tooltip
            contentStyle={{ borderRadius: 8, fontSize: 12 }}
            formatter={(value, name) =>
              name === "revenue" ? [Number(value).toFixed(2), "Revenue"] : [String(value), "Orders"]
            }
          />
          <Legend />
          <Bar yAxisId="count" dataKey="orderCount" name="Orders" fill="var(--color-status-preparing)" radius={[4, 4, 0, 0]} />
          <Line
            yAxisId="revenue"
            type="monotone"
            dataKey="revenue"
            name="revenue"
            stroke="var(--color-primary)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--color-primary)" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
