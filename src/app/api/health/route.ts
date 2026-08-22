import { NextResponse } from "next/server";

// Deliberately DB-free: deploy-watch phase 3 asserts "this build serves
// traffic on this domain"; database health is the backup canary's job.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  });
}
