import { NextResponse } from "next/server";
import { resolvePurchasingContext } from "@/app/dashboard/purchasing-permission";
import { getPoVariance } from "@/server/purchasing/variance";
import { PoNotFoundError, NoBranchError } from "@/server/purchasing/errors";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolvePurchasingContext("purchasing:manage");
  if (denied) return denied;
  const { id } = await params;
  try {
    const variance = await getPoVariance(ctx.tenantId, id);
    return NextResponse.json({ variance });
  } catch (e) {
    if (e instanceof NoBranchError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof PoNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
