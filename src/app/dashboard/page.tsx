import { redirect } from "next/navigation";
import Link from "next/link";
import QRCode from "qrcode";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { can } from "@/server/rbac/authorize";
import { listBranches } from "@/server/branches/service";
import { listProducts } from "@/server/catalog/service";
import { listOrders } from "@/server/ordering/service";
import { getTenantById } from "@/server/tenancy";
import { getEnv } from "@/env";
import { onboardingSteps } from "@/lib/onboarding";
import { orderStatusMeta } from "@/lib/order-status";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/dashboard/CopyLinkButton";
import { CheckCircle2, Circle, ExternalLink, Download, QrCode, ArrowUpRight } from "lucide-react";

export default async function DashboardHome() {
  const { tenantId, roleKeys } = await requireDashboardUser();

  // Staff (Orders is their only section) have no Home — send them to Orders.
  if (!can(roleKeys, "menu:manage") && !can(roleKeys, "fulfillment:manage")) {
    redirect("/dashboard/orders");
  }

  const [branches, products, orders, tenant] = await Promise.all([
    listBranches(tenantId),
    listProducts(tenantId),
    listOrders(tenantId, { limit: 100 }),
    getTenantById(tenantId),
  ]);

  const steps = onboardingSteps({
    branchCount: branches.length,
    publishedProductCount: products.filter((p) => p.isPublished).length,
    hasOpeningHours: branches.some((b) => (b.openingHours ?? []).length > 0),
    acceptingOrders: branches.some((b) => b.acceptingOrders),
  });

  const counts = orders.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  const snapshot = (["pending", "preparing", "ready", "completed"] as const).map((s) => ({
    status: s, count: counts[s] ?? 0, meta: orderStatusMeta(s),
  }));

  const completedSteps = steps.filter((s) => s.done).length;
  const setupProgress = steps.length > 0 ? Math.round((completedSteps / steps.length) * 100) : 0;

  // Storefront share — only render when we can safely resolve the tenant/host.
  let storefrontShare: { url: string; qrDataUrl: string } | null = null;
  if (tenant) {
    const rootDomain = getEnv().ROOT_DOMAIN;
    const protocol = rootDomain.includes("localhost") ? "http" : "https";
    const storefrontUrl = `${protocol}://${tenant.slug}.${rootDomain}`;
    try {
      const qrDataUrl = await QRCode.toDataURL(storefrontUrl, { width: 512, margin: 1 });
      storefrontShare = { url: storefrontUrl, qrDataUrl };
    } catch {
      storefrontShare = null;
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Home"
        description="Your setup progress and a snapshot of recent orders."
      />

      {storefrontShare && (
        <Card className="relative overflow-hidden p-6 sm:p-8 mb-6 ring-1 ring-primary/10 bg-gradient-to-br from-card via-card to-secondary/30">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="inline-flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <QrCode className="size-4" />
                </span>
                <span className="eyebrow text-primary">Your storefront</span>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Share this link or QR code with customers to take them straight to your live menu.
              </p>
              <div className="font-mono text-sm sm:text-base text-ink break-all leading-relaxed">
                {storefrontShare.url}
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-4">
                <CopyLinkButton value={storefrontShare.url} />
                <Button asChild variant="outline" size="sm">
                  <a href={storefrontShare.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-4" />
                    Visit storefront
                  </a>
                </Button>
              </div>
            </div>

            <div className="flex flex-col items-start md:items-center gap-3 md:pl-6 md:border-l md:border-border/60">
              <img
                src={storefrontShare.qrDataUrl}
                alt="QR code linking to your storefront"
                width={200}
                height={200}
                className="size-[180px] sm:size-[200px] rounded-xl ring-1 ring-border/60 bg-white"
              />
              <Button asChild variant="ghost" size="sm">
                <a href={storefrontShare.qrDataUrl} download="serveos-menu-qr.png">
                  <Download className="size-4" />
                  Download QR code
                </a>
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-5 sm:p-6 mb-6">
        <div className="flex items-center justify-between mb-4 gap-4">
          <h2 className="eyebrow text-primary">Get set up</h2>
          <span className="text-xs font-medium text-muted-foreground tabular-nums shrink-0">
            {completedSteps}/{steps.length} complete
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden mb-5">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${setupProgress}%` }}
          />
        </div>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
          {steps.map((step) => (
            <li key={step.key}>
              <Link href={step.href} className="flex items-center gap-3 text-sm hover:underline">
                {step.done
                  ? <CheckCircle2 className="size-5 text-primary shrink-0" />
                  : <Circle className="size-5 text-muted-foreground/40 shrink-0" />}
                <span className={step.done ? "text-muted-foreground line-through" : "text-ink"}>
                  {step.label}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <div className="flex items-baseline justify-between mb-3 gap-4">
        <h2 className="eyebrow text-primary">Today&apos;s orders</h2>
        <Link
          href="/dashboard/orders"
          className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 transition-colors"
        >
          View all
          <ArrowUpRight className="size-3" />
        </Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {snapshot.map((s) => (
          <Card key={s.status} className="p-4 sm:p-5">
            <div className="font-display text-4xl sm:text-5xl font-bold text-ink tracking-tight tabular-nums">
              {s.count}
            </div>
            <div className={`inline-block mt-2 rounded-full px-2.5 py-0.5 text-xs font-medium ${s.meta.badgeClass}`}>
              {s.meta.label}
            </div>
          </Card>
        ))}
      </div>

      {storefrontShare && (
        <p className="text-xs text-muted-foreground mt-6">
          Need a printable QR sheet or more sharing options?{" "}
          <Link href="/dashboard/publish" className="text-primary hover:underline">
            Publish your menu
          </Link>
          .
        </p>
      )}
    </>
  );
}
