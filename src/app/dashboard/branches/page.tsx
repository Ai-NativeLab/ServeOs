import Link from "next/link";
import { MapPin, Phone, ChevronRight } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listBranches } from "@/server/branches/service";
import { createBranchAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function BranchesPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const branches = await listBranches(ctx.tenantId);

  return (
    <>
      <PageHeader
        eyebrow="Locations"
        title="Branches"
        description="Your restaurant's locations. Hours and delivery areas are set per branch in Settings."
      />

      {branches.length === 0 ? (
        <EmptyState
          title="No branches yet"
          description="Add your first location below — orders and opening hours are managed per branch."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 mb-6">
          {branches.map((b) => (
            <Link key={b.id} href={`/dashboard/branches/${b.id}`}>
              <Card className="p-5 hover:border-primary/40 transition-colors h-full">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="font-display font-bold text-ink">{b.name}</div>
                    {b.address && (
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <MapPin className="size-4" strokeWidth={1.5} />{b.address}
                      </div>
                    )}
                    {b.phone && (
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Phone className="size-4" strokeWidth={1.5} /><span className="font-mono">{b.phone}</span>
                      </div>
                    )}
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Card className="p-5 max-w-2xl">
        <h2 className="eyebrow text-primary mb-3">Add branch</h2>
        <form action={createBranchAction} className="grid gap-4">
          <div className="grid md:grid-cols-3 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="address">Address (optional)</Label>
              <Input id="address" name="address" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="phone">Phone (optional)</Label>
              <Input id="phone" name="phone" />
            </div>
          </div>
          <div><SubmitButton>Create branch</SubmitButton></div>
        </form>
      </Card>
    </>
  );
}
