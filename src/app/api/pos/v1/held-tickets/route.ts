import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier } from "@/server/pos/require-cashier";
import { holdTicket, listHeldTickets } from "@/server/pos/held-tickets";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";

async function ctxOr401(req: NextRequest) {
  try {
    return { ctx: await requirePosCashier(req) };
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return { res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    throw e;
  }
}

export async function GET(req: NextRequest) {
  const { ctx, res } = await ctxOr401(req);
  if (!ctx) return res!;
  return NextResponse.json({ tickets: await listHeldTickets(ctx) });
}

export async function POST(req: NextRequest) {
  const { ctx, res } = await ctxOr401(req);
  if (!ctx) return res!;

  const { label, draft } = (await req.json()) as { label?: string; draft?: unknown };
  if (!draft) return NextResponse.json({ error: "Missing draft" }, { status: 400 });

  return NextResponse.json(await holdTicket(ctx, label ?? "Ticket", draft));
}
