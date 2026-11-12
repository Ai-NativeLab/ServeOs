import { NextResponse } from "next/server";
import { resolveFiscalContext } from "@/app/dashboard/fiscal-permission";
import { listProductTaxCodes } from "@/server/fiscal/config-service";

/**
 * Every product the tenant sells, split into classified and unclassified.
 *
 * Both halves in one response, mirroring the devices route: the products with
 * NO ETA classification are the rows an operator opens this screen to clear, and
 * a list of only the finished ones cannot show them. An unclassified product
 * fails its receipt permanently (`MissingTaxCodeError`) the moment it is sold.
 */
export async function GET() {
  const { ctx, denied } = await resolveFiscalContext();
  if (denied) return denied;
  return NextResponse.json(await listProductTaxCodes(ctx.tenantId));
}
