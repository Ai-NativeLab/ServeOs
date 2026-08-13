import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { startDemoSession } from "@/server/demo/session";

/**
 * The dashboard door on the marketing page's demo cards.
 *
 * `getDemoEntry()` has pointed at this path since the marketing site shipped,
 * but the route itself belonged to a follow-on spec that never landed — so all
 * four "Open the dashboard" buttons 404'd in QA and production.
 *
 * It signs the visitor into the demo tenant for the requested trade WITHOUT
 * asking for credentials. That is the point of a demo, and it is also why the
 * tenant it can reach is constrained to `demo-<trade>` by two separate guards
 * in startDemoSession. Row-level security contains everything after that: a
 * demo visitor is scoped to the demo tenant like any other user is scoped to
 * theirs.
 *
 * The demo is deliberately writable, so visitors will change it. That damage
 * is undone nightly by .github/workflows/demo-reset.yml.
 *
 * GET, because it is reached by following a link. It has a side effect, which
 * a GET normally should not — but the alternative is a POST form on a
 * marketing page, and the effect here is limited to minting a session for a
 * throwaway tenant. `no-store` keeps any cache from serving one visitor's
 * redirect to another.
 */
export async function GET(req: NextRequest) {
  const trade = req.nextUrl.searchParams.get("trade") ?? "";
  const result = await startDemoSession(trade);

  if (!result.ok) {
    // Never leak which of "that trade does not exist" and "that tenant is not
    // seeded here" happened; both are the same dead end to a visitor. Send
    // them back to the demo section rather than showing a bare error.
    const back = new URL("/#demo", req.nextUrl.origin);
    back.searchParams.set("demo", result.reason === "unknown_trade" ? "unknown" : "unavailable");
    return NextResponse.redirect(back, { status: 303 });
  }

  const res = NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin), { status: 303 });
  res.cookies.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: req.nextUrl.protocol === "https:",
    expires: result.expiresAt,
  });
  res.headers.set("cache-control", "no-store");
  return res;
}
