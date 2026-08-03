// src/components/admin/charts.tsx
"use client";
// Colours reference the design tokens DIRECTLY: --primary is a hex
// (#f0522b in globals.css), so the hsl(var(--primary)) form these charts used
// produced invalid CSS and recharts rendered them colourless. Alpha comes from
// color-mix, not an hsl slash-alpha that a hex token cannot supply.
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SignupChart({ data }: { data: { day: string; count: number }[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>Signups (30d)</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Line type="monotone" dataKey="count" stroke="var(--primary)" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function MrrChart({ data }: { data: { day: string; mrr: number }[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>MRR trend (30d)</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Area type="monotone" dataKey="mrr" stroke="var(--primary)" fill="color-mix(in srgb, var(--primary) 20%, transparent)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function StatusChart({ data }: { data: { status: string; count: number }[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>Tenants by status</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="status" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="count" fill="var(--primary)" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
