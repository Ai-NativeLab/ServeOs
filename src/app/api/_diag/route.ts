import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

// TEMPORARY diagnostic endpoint — reports DB connectivity from the Vercel
// runtime without leaking credentials. Remove after debugging.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("token") !== "serveos-diag-2026") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = process.env.DATABASE_URL;
  const info: Record<string, unknown> = {
    hasDatabaseUrl: !!url,
    vercelRegion: process.env.VERCEL_REGION ?? null,
  };

  if (url) {
    try {
      const u = new URL(url);
      info.host = u.hostname;
      info.port = u.port;
      info.database = u.pathname.replace(/^\//, "");
      info.user = u.username; // role name only; password intentionally not read
    } catch (e) {
      info.urlParseError = String(e);
    }

    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 8000 });
    try {
      const r = await pool.query("select 1 as ok");
      info.connect = "ok";
      info.query = r.rows[0];
    } catch (e: unknown) {
      const err = e as { message?: string; code?: string };
      info.connect = "FAILED";
      info.errorMessage = err?.message;
      info.errorCode = err?.code;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  return NextResponse.json(info);
}
