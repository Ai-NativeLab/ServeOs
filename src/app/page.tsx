import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";
import { getActiveBanners } from "@/server/banners/service";
import { listBranches } from "@/server/branches/service";
import { BranchSelector } from "./_components/BranchSelector";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const h = await headers();
  const surface = h.get("x-surface");
  const slug = h.get("x-tenant-slug");

  if (surface === "storefront" && slug) {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      return <main style={{ padding: 48, fontFamily: "system-ui" }}><h1>Restaurant not found</h1></main>;
    }
    if (!isTenantServable(tenant)) {
      return (
        <main style={{ padding: 48, fontFamily: "system-ui" }}>
          <h1>{tenant.name}</h1>
          <p>This restaurant is getting ready. Check back soon!</p>
        </main>
      );
    }

    const { branch: branchId } = await searchParams;

    const [banners, menu, branches] = await Promise.all([
      getActiveBanners(tenant.id),
      getPublishedMenu(tenant.id, branchId),
      listBranches(tenant.id),
    ]);

    return (
      <main style={{ fontFamily: "system-ui" }}>
        {banners.length > 0 && (
          <section style={{ display: "flex", gap: 8, overflowX: "auto", padding: "16px 24px" }}>
            {banners.map((b) => (
              <a key={b.id} href={b.linkUrl ?? "#"}>
                <img src={b.imageUrl} alt={b.titleEn ?? ""} style={{ height: 160, borderRadius: 8 }} />
              </a>
            ))}
          </section>
        )}

        {branches.length > 1 && (
          <section style={{ padding: "8px 24px" }}>
            <BranchSelector branches={branches} currentBranchId={branchId} />
          </section>
        )}

        <section style={{ padding: "0 24px 32px" }}>
          <h1 style={{ fontSize: 28, marginBottom: 4 }}>{tenant.name}</h1>
          {menu.categories.length === 0 && <p>Menu coming soon.</p>}
          {menu.categories.map((cat) => (
            <div key={cat.id} style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 20, borderBottom: "2px solid currentColor", paddingBottom: 4 }}>
                {cat.nameEn} / {cat.nameAr}
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 16, marginTop: 12 }}>
                {cat.products.map((p) => (
                  <div key={p.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
                    {p.imageUrl && <img src={p.imageUrl} alt={p.nameEn} style={{ width: "100%", height: 160, objectFit: "cover" }} />}
                    <div style={{ padding: 12 }}>
                      <div style={{ fontWeight: 600 }}>{p.nameEn}</div>
                      <div dir="rtl" style={{ color: "#6b7280", fontSize: 14 }}>{p.nameAr}</div>
                      {p.descriptionEn && <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>{p.descriptionEn}</p>}
                      <div style={{ marginTop: 8, fontWeight: 700 }}>
                        {p.effectivePrice.toFixed(2)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      </main>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <nav style={{ background: "#0f172a", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 28, height: 28, background: "#f97316", borderRadius: 6 }} />
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 18 }}>ServeOS</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <a href="/login" style={{ color: "#94a3b8", textDecoration: "none", fontSize: 14 }}>Sign in</a>
          <a href="/register" style={{ background: "#f97316", color: "#fff", padding: "8px 18px", borderRadius: 6, textDecoration: "none", fontSize: 14, fontWeight: 600 }}>Get started</a>
        </div>
      </nav>

      <section style={{ background: "#0f172a", padding: "80px 32px", textAlign: "center", flex: 1 }}>
        <h1 style={{ color: "#fff", fontSize: 40, fontWeight: 800, margin: 0, lineHeight: 1.15 }}>
          Run your restaurant.<br />Not your software.
        </h1>
        <p style={{ color: "#64748b", fontSize: 18, marginTop: 12 }}>
          Menu, orders, WhatsApp commerce — one platform.
        </p>
        <div style={{ marginTop: 32, display: "inline-flex", gap: 12 }}>
          <a href="/register" style={{ background: "#f97316", color: "#fff", padding: "12px 24px", borderRadius: 6, textDecoration: "none", fontSize: 15, fontWeight: 600 }}>Get started free</a>
          <a href="/login" style={{ border: "1px solid #334155", color: "#94a3b8", padding: "12px 24px", borderRadius: 6, textDecoration: "none", fontSize: 15 }}>Sign in →</a>
        </div>
      </section>

      <section style={{ background: "#fff", display: "grid", gridTemplateColumns: "repeat(3,1fr)", borderTop: "1px solid #f1f5f9" }}>
        {[
          { emoji: "🍽️", title: "Menu & Catalog", desc: "Products, categories, branches, and modifiers. Your full menu online." },
          { emoji: "📦", title: "Online Ordering", desc: "Cart, checkout, and real-time order tracking for your customers." },
          { emoji: "💬", title: "WhatsApp Commerce", desc: "Let customers order via WhatsApp chatbot — no app needed." },
        ].map((pillar, i) => (
          <div key={pillar.title} style={{ padding: "32px 24px", borderRight: i < 2 ? "1px solid #f1f5f9" : undefined }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>{pillar.emoji}</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a", marginBottom: 6 }}>{pillar.title}</div>
            <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}>{pillar.desc}</div>
          </div>
        ))}
      </section>

      <footer style={{ background: "#0f172a", padding: "20px 32px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: "#475569", fontSize: 13 }}>© 2026 ServeOS</span>
        <div style={{ display: "flex", gap: 16 }}>
          <a href="#" style={{ color: "#475569", fontSize: 13, textDecoration: "none" }}>Privacy</a>
          <a href="#" style={{ color: "#475569", fontSize: 13, textDecoration: "none" }}>Terms</a>
        </div>
      </footer>
    </div>
  );
}
