import { NextResponse, type NextRequest } from "next/server";
import { classifyHost } from "./middleware-routing";
import { declaresLocaleInQuery, marketingLocaleAction, queryLocale } from "./marketing-locale";

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

    // /subscribe falls through the allowlist deliberately, but it is still a
    // marketing page and it carries its locale in ?lang. Declaring it here is
    // what gives the ROOT layout the right dir/lang on a direct load — without
    // it, an Arabic enquiry form renders inside an LTR, lang="en" document.
    if (action.kind === "none" && declaresLocaleInQuery(req.nextUrl.pathname)) {
      requestHeaders.set("x-locale", queryLocale(req.nextUrl.searchParams.get("lang")));
    }
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js).*)"],
};
