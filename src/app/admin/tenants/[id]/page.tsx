// src/app/admin/tenants/[id]/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { getTenantDetail, listAuditLogs } from "@/server/platform";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSuperAdmin();
  const { id } = await params;
  const detail = await getTenantDetail(id);
  if (!detail) notFound();
  const { tenant, plan, subscription, branchCount, productCount, publishedProductCount, orderCount } = detail;
  const audit = await listAuditLogs({ tenantId: id, limit: 25 });

  return (
    <>
      <PageHeader
        eyebrow={tenant.vertical}
        title={tenant.name}
        description={`${tenant.slug} · ${tenant.country}`}
        action={<Link href="/admin/tenants" className="text-sm text-primary hover:underline">← All tenants</Link>}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge variant={tenant.status === "active" ? "default" : tenant.status === "suspended" ? "destructive" : "outline"}>{tenant.status}</Badge>
        {plan && <Badge variant="secondary">{plan.name}</Badge>}
        {subscription?.status && <Badge variant="outline">{subscription.status}</Badge>}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card><CardContent className="py-4"><div className="text-2xl font-bold">{branchCount}</div><div className="text-xs text-muted-foreground">Branches</div></CardContent></Card>
            <Card><CardContent className="py-4"><div className="text-2xl font-bold">{publishedProductCount}/{productCount}</div><div className="text-xs text-muted-foreground">Published products</div></CardContent></Card>
            <Card><CardContent className="py-4"><div className="text-2xl font-bold">{orderCount}</div><div className="text-xs text-muted-foreground">Orders</div></CardContent></Card>
            <Card><CardContent className="py-4"><div className="text-2xl font-bold">{tenant.currency}</div><div className="text-xs text-muted-foreground">Currency</div></CardContent></Card>
          </div>
          <Card className="mt-3">
            <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-1">
              <div><span className="text-muted-foreground">Tagline:</span> {tenant.tagline ?? "—"}</div>
              <div><span className="text-muted-foreground">Timezone:</span> {tenant.timezone}</div>
              <div><span className="text-muted-foreground">Created:</span> {tenant.createdAt.toISOString().slice(0, 10)}</div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader><CardTitle>Audit trail</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {audit.length === 0 && <p className="text-muted-foreground">No audit events.</p>}
              {audit.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3">
                  <span><Badge variant="outline">{a.action}</Badge></span>
                  <span className="text-xs text-muted-foreground">{a.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
