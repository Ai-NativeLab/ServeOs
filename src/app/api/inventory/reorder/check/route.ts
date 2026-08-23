import { NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { checkReorder } from "@/server/purchasing/reorder";
import { purchasingErrorResponse } from "../../../purchasing-errors";

export async function POST() {
  const { ctx, denied } = await resolvePurchasingContext("purchasing:manage");
  if (denied) return denied;
  try {
    const run = await checkReorder(await resolvePurchasingActor(ctx));
    return NextResponse.json(run);
  } catch (e) {
    const mapped = purchasingErrorResponse(e);
    if (mapped) return mapped;
    console.error("checkReorder failed", { tenantId: ctx.tenantId, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
