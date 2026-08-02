"use client";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";

export type BreakdownDatum = { label: string; value: number };

/** Reusable horizontal-category bar, styled like RevenueChart. */
export function BreakdownChart({ data, valueLabel = "Revenue" }: { data: BreakdownDatum[]; valueLabel?: string }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="currentColor" className="text-muted-foreground" />
          <YAxis tick={{ fontSize: 12 }} stroke="currentColor" className="text-muted-foreground" />
          <Tooltip
            contentStyle={{ borderRadius: 8, fontSize: 12 }}
            formatter={(value) => [Number(value).toFixed(2), valueLabel]}
          />
          <Bar dataKey="value" name={valueLabel} fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
