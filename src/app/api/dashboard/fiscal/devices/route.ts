import { NextResponse } from "next/server";
import { resolveFiscalContext } from "@/app/dashboard/fiscal-permission";
import { listDeviceCredentials, listFiscalDevices } from "@/server/fiscal/config-service";

/**
 * Every POS device the tenant owns, plus the ETA credential each one holds
 * (masked — `hasSecret1`/`hasSecret2`/`hasPresharedKey` booleans, never a
 * reference value).
 *
 * Both halves in one response because the dashboard needs both to be useful:
 * the credential list alone cannot show a till that has not been registered
 * with ETA yet, which is exactly the row an operator is looking for.
 */
export async function GET() {
  const { ctx, denied } = await resolveFiscalContext();
  if (denied) return denied;
  const [devices, credentials] = await Promise.all([
    listFiscalDevices(ctx.tenantId),
    listDeviceCredentials(ctx.tenantId),
  ]);
  return NextResponse.json({ devices, credentials });
}
