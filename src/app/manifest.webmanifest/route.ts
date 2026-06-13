import { headers } from "next/headers";
import { getTenantBySlug } from "@/server/tenancy";
import { buildManifest } from "@/server/tenancy/manifest";

export async function GET() {
  const slug = (await headers()).get("x-tenant-slug");
  const tenant = slug ? await getTenantBySlug(slug) : null;
  const manifest = tenant
    ? buildManifest({ name: tenant.name, primaryColor: tenant.primaryColor, slug: tenant.slug })
    : buildManifest({ name: "ServeOS", primaryColor: "#0F172A", slug: "serveos" });

  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
