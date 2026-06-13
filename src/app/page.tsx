import { headers } from "next/headers";
import { getTenantBySlug } from "@/server/tenancy";

export default async function Home() {
  const h = await headers();
  const surface = h.get("x-surface");
  const slug = h.get("x-tenant-slug");

  if (surface === "storefront" && slug) {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      return <main style={{ padding: 48, fontFamily: "system-ui" }}><h1>Restaurant not found</h1></main>;
    }
    const published = tenant.status === "active";
    return (
      <main style={{ padding: 48, fontFamily: "system-ui", color: tenant.primaryColor }}>
        <h1>{tenant.name}</h1>
        <p>{published ? "Welcome — our menu is coming online soon." : "This restaurant is getting ready. Check back soon!"}</p>
      </main>
    );
  }

  return (
    <main style={{ padding: 48, fontFamily: "system-ui" }}>
      <h1>ServeOS</h1>
      <p>The operating system for restaurants. Online ordering, reservations, and WhatsApp commerce.</p>
    </main>
  );
}
