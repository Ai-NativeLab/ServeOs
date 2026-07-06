import { requireTenantManagePermission } from "../profile-permission";
import { listBranches } from "@/server/branches/service";
import { listDevices } from "@/server/pos/service";
import { revokeDeviceAction } from "./actions";
import { PairingForm } from "./PairingForm";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Branch } from "@/server/branches/schema";

export default async function PosDevicesPage() {
  const { tenantId } = await requireTenantManagePermission();
  const [devices, branches] = await Promise.all([listDevices(tenantId), listBranches(tenantId)]);
  const branchName = new Map<string, string>(branches.map((b: Branch) => [b.id, b.name]));

  return (
    <>
      <PageHeader
        title="POS devices"
        description="Pair desktop POS terminals with a branch, and revoke access when a device is retired."
      />

      <Card className="p-5 max-w-xl mb-6">
        <h2 className="eyebrow text-primary mb-3">Pair a device</h2>
        {branches.length === 0 ? (
          <p className="text-sm text-muted-foreground">Create at least one branch first.</p>
        ) : (
          <PairingForm branches={branches.map((b) => ({ id: b.id, name: b.name }))} />
        )}
      </Card>

      <h2 className="eyebrow text-muted-foreground mb-3">Paired devices</h2>
      {devices.length === 0 ? (
        <EmptyState
          title="No paired devices"
          description="Generate a pairing code above and enter it in the POS app to add a device."
        />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.label}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {branchName.get(d.branchId) ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "Never"}
                  </TableCell>
                  <TableCell>
                    {d.revokedAt ? (
                      <span className="text-muted-foreground">Revoked</span>
                    ) : (
                      <span>Active</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!d.revokedAt && (
                      <ConfirmActionButton
                        action={revokeDeviceAction.bind(null, d.id)}
                        label="Revoke"
                        size="sm"
                        variant="ghost"
                        title={`Revoke ${d.label}?`}
                        description="The POS terminal will no longer be able to authenticate. A new pairing code will be required to re-pair it."
                        successMessage="Device revoked"
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
