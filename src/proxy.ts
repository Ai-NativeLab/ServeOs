import { NextResponse, type NextRequest } from "next/server";
import { classifyHost } from "./middleware-routing";

export function proxy(req: NextRequest) {
  const root = process.env.ROOT_DOMAIN ?? "serveos.localhost";
  const host = req.headers.get("host") ?? root;
  const cls = classifyHost(host, root);

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-surface", cls.surface);
  if (cls.surface === "storefront") {
    requestHeaders.set("x-tenant-slug", cls.slug);
  } else {
    // Prevent a client from spoofing x-tenant-slug on non-storefront hosts.
    requestHeaders.delete("x-tenant-slug");
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js).*)"],
};
