import { NextRequest, NextResponse } from "next/server";
import { resolveFiscalContext } from "@/app/dashboard/fiscal-permission";
import { actionAudit } from "@/server/audit/action-context";
import {
  listProductTaxCodes,
  upsertProductTaxCode,
  type UpsertProductTaxCodeInput,
} from "@/server/fiscal/config-service";
import { fiscalErrorResponse, redactedCause } from "../../fiscal-errors";

/**
 * One product's ETA classification, or a 404 when it has none.
 *
 * Same shape as `devices/[deviceId]`: the collection route lists everything, and
 * the per-entity route reads and writes one row keyed by an id the tenant
 * already owns. `product_tax_codes` has no id worth exposing — the product IS
 * the key (`product_tax_codes_product` is unique on tenant + product) — so the
 * segment is the product id and `PUT` is an upsert, not a create.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ productId: string }> }) {
  const { ctx, denied } = await resolveFiscalContext();
  if (denied) return denied;
  const { productId } = await params;
  const { classified } = await listProductTaxCodes(ctx.tenantId);
  const row = classified.find((c) => c.productId === productId);
  if (!row) return NextResponse.json({ error: "No ETA classification for this product" }, { status: 404 });
  return NextResponse.json(row);
}

/**
 * Classifies (or re-classifies) one product.
 *
 * The product id comes from the PATH, never from the body: a body-supplied id
 * would let one URL write another product's row, and the two could disagree.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ productId: string }> }) {
  const { ctx, denied } = await resolveFiscalContext();
  if (denied) return denied;
  const { productId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid tax code" }, { status: 400 });
  }

  try {
    const view = await upsertProductTaxCode(
      ctx.tenantId,
      { ...(body as Omit<UpsertProductTaxCodeInput, "productId">), productId },
      await actionAudit(ctx),
    );
    return NextResponse.json(view);
  } catch (e) {
    const mapped = fiscalErrorResponse(e);
    if (mapped) return mapped;
    // Redacted like the sibling write routes. Nothing on this path carries a
    // credential reference, but a uniform shape has no exception to remember —
    // see `redactedCause`.
    console.error("upsertProductTaxCode failed", { tenantId: ctx.tenantId, productId, ...redactedCause(e) });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
