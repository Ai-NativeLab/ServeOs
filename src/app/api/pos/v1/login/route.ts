import { NextRequest, NextResponse } from "next/server";
import { loginForPos } from "@/server/pos/service";
import { PosLoginError } from "@/server/pos/errors";

export async function POST(req: NextRequest) {
  const { slug, email, password, branchId } = (await req.json()) as {
    slug?: string;
    email?: string;
    password?: string;
    branchId?: string;
  };
  if (!slug || !email || !password) {
    return NextResponse.json({ error: "Missing restaurant, email, or password" }, { status: 400 });
  }
  try {
    const res = await loginForPos(slug.trim().toLowerCase(), email.trim(), password, branchId ?? null);
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof PosLoginError) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }
}
