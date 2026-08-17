import { NextResponse, type NextRequest } from "next/server";
import { classifyHost } from "./middleware-routing";
import { marketingLocaleAction } from "./marketing-locale";

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
  // Same reasoning: only this function may declare the marketing locale.
  requestHeaders.delete("x-locale");

  if (cls.surface === "marketing") {
    const action = marketingLocaleAction(req.nextUrl.pathname);

    if (action.kind === "redirect") {
      const url = req.nextUrl.clone();
      url.pathname = action.pathname;
      return NextResponse.redirect(url);
    }

    if (action.kind === "rewrite") {
      requestHeaders.set("x-locale", action.locale);
      const url = req.nextUrl.clone();
      url.pathname = action.pathname;
      return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
    }

    if (action.kind === "pass") {
      requestHeaders.set("x-locale", action.locale);
    }
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js).*)"],
};
