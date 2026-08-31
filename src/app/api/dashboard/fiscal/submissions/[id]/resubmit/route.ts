import { NextRequest, NextResponse } from "next/server";
import { resolveFiscalContext } from "@/app/dashboard/fiscal-permission";
import { requestResubmission } from "@/app/dashboard/fiscal/resubmit";

/**
 * Queues a corrected resubmission of a rejected document, on the owner's say-so.
 *
 * The act itself — precondition checks, the enqueue, and the who-asked-for-it
 * audit event this surface owes (see `audit/coverage.ts`'s
 * `enqueue.enqueueCorrectedResubmission` entry) — lives in
 * `@/app/dashboard/fiscal/resubmit`, because the dashboard PAGE reaches the same
 * act through a server action and the audit emission must not be duplicated
 * across the two. This handler is the HTTP shape of it and nothing else.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolveFiscalContext();
  if (denied) return denied;
  const { id } = await params;

  const outcome = await requestResubmission(ctx, id);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  return NextResponse.json({ submissionId: outcome.submissionId }, { status: 201 });
}
