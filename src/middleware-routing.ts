export type HostClass =
  | { surface: "dashboard" }
  | { surface: "admin" }
  | { surface: "marketing" }
  | { surface: "storefront"; slug: string };

export function classifyHost(host: string, rootDomain: string): HostClass {
  const h = host.split(":")[0].toLowerCase();
  if (h === `app.${rootDomain}`) return { surface: "dashboard" };
  if (h === `admin.${rootDomain}`) return { surface: "admin" };
  if (h === rootDomain || h === `www.${rootDomain}`) return { surface: "marketing" };
  const sub = h.endsWith(`.${rootDomain}`) ? h.slice(0, -(`.${rootDomain}`.length)) : null;
  if (sub && !sub.includes(".")) return { surface: "storefront", slug: sub };
  return { surface: "marketing" };
}
