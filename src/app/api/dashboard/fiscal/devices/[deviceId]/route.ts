import { NextRequest, NextResponse } from "next/server";
import { resolveFiscalContext } from "@/app/dashboard/fiscal-permission";
import { actionAudit } from "@/server/audit/action-context";
import {
  getDeviceCredential,
  upsertDeviceCredential,
  type UpsertDeviceCredentialInput,
} from "@/server/fiscal/config-service";
import { fiscalErrorResponse, redactedCause } from "../../fiscal-errors";

/** One device's ETA credential, masked, or a 404 when it has none recorded. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  const { ctx, denied } = await resolveFiscalContext();
  if (denied) return denied;
  const { deviceId } = await params;
  const credential = await getDeviceCredential(ctx.tenantId, deviceId);
  if (!credential) return NextResponse.json({ error: "No ETA credential for this device" }, { status: 404 });
  return NextResponse.json(credential);
}

/**
 * Records or updates one device's ETA credential.
 *
 * A device that is not this tenant's, an illegal status transition and a
 * missing secret reference on first save all arrive as the service's one input
 * error and leave as a 400 naming the field — see `fiscalErrorResponse`.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  const { ctx, denied } = await resolveFiscalContext();
  if (denied) return denied;
  const { deviceId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid device credential" }, { status: 400 });
  }

  try {
    const view = await upsertDeviceCredential(
      ctx.tenantId,
      deviceId,
      body as UpsertDeviceCredentialInput,
      await actionAudit(ctx),
    );
    return NextResponse.json(view);
  } catch (e) {
    const mapped = fiscalErrorResponse(e);
    if (mapped) return mapped;
    // Redacted for the same reason as the config route — see `redactedCause`.
    console.error("upsertDeviceCredential failed", { tenantId: ctx.tenantId, deviceId, ...redactedCause(e) });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
