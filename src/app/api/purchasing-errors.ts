import { NextResponse } from "next/server";
import {
  InvalidPoInputError,
  InvalidPoTransitionError,
  NoBranchError,
  PoNotFoundError,
  ReceiptUomMismatchError,
  SupplierEmailMissingError,
} from "@/server/purchasing/errors";

/**
 * The one purchasing error ladder. #125 asks for error mapping "in every route"
 * and "malformed body → 400 never 500"; the suppliers, reorder and PO-create
 * routes instead caught everything into an opaque 500, so a cross-tenant id
 * (InvalidPoInputError) or a zero-branch tenant (NoBranchError) read as a
 * server fault.
 *
 * Returns null when the error is not a known domain error, so the caller logs
 * it and returns its own opaque 500 — an unrecognised failure must never leak
 * internals to the client.
 *
 * Lives beside the routes rather than in them because a route module may only
 * export its HTTP handlers.
 */
export function purchasingErrorResponse(e: unknown): NextResponse | null {
  if (e instanceof NoBranchError) return NextResponse.json({ error: e.message }, { status: 409 });
  if (e instanceof PoNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
  if (e instanceof InvalidPoTransitionError) return NextResponse.json({ error: e.message }, { status: 409 });
  if (e instanceof SupplierEmailMissingError) return NextResponse.json({ error: e.message }, { status: 422 });
  if (e instanceof InvalidPoInputError || e instanceof ReceiptUomMismatchError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  return null;
}
