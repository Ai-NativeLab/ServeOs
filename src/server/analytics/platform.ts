// src/server/analytics/platform.ts
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";

export type SignupPoint = { day: string; count: number };
export async function getPlatformSignups(days: number): Promise<SignupPoint[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { rows } = await db.execute<{ day: string; count: string }>(sql`
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS count
    FROM tenants WHERE created_at >= ${since}
    GROUP BY day ORDER BY day
  `);
  return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}

export type StatusCount = { status: string; count: number };
export async function getTenantsByStatus(): Promise<StatusCount[]> {
  const { rows } = await db.execute<{ status: string; count: string }>(sql`
    SELECT status, COUNT(*) AS count FROM tenants GROUP BY status
  `);
  return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
}

export async function getPlatformMrr(): Promise<number> {
  const { rows } = await db.execute<{ mrr: string }>(sql`
    SELECT COALESCE(SUM(p.price_monthly::numeric), 0) AS mrr
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    WHERE s.status IN ('active', 'trialing')
  `);
  return Number(rows[0]?.mrr ?? 0);
}

export type MrrPoint = { day: string; mrr: number };
export async function getPlatformMrrTrend(days: number): Promise<MrrPoint[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { rows } = await db.execute<{ day: string; mrr: string }>(sql`
    SELECT d.day, COALESCE(SUM(p.price_monthly::numeric), 0) AS mrr
    FROM generate_series(${since}, now(), '1 day') AS d(day)
    LEFT JOIN subscriptions s ON s.status IN ('active','trialing') AND s.created_at <= d.day
    LEFT JOIN plans p ON p.id = s.plan_id
    GROUP BY d.day ORDER BY d.day
  `);
  return rows.map((r) => ({ day: r.day, mrr: Number(r.mrr) }));
}

export async function getTrialsEndingSoon(days: number): Promise<number> {
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const { rows } = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*) AS count FROM subscriptions
    WHERE status = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at <= ${until}
  `);
  return Number(rows[0]?.count ?? 0);
}
