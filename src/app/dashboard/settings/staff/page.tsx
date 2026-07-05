import { requireStaffPermission } from "../staff-permission";
import { listStaff } from "@/server/auth/staff";
import { createStaffAction, setStaffRoleAction, deactivateStaffAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default async function StaffPage() {
  const { tenantId } = await requireStaffPermission();
  const staff = await listStaff(tenantId);

  return (
    <>
      <PageHeader title="Staff" description="Managers and staff who can sign in to this dashboard." />

      <Card className="p-5 max-w-xl mb-6">
        <h2 className="eyebrow text-primary mb-3">Add staff</h2>
        <ToastForm action={createStaffAction} successMessage="Staff member added" className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required />
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" />
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="password">Temporary password</Label>
              <Input id="password" name="password" type="password" required minLength={8} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="roleKey">Role</Label>
              <select id="roleKey" name="roleKey" defaultValue="staff" className={selectClass}>
                <option value="manager">Manager</option>
                <option value="staff">Staff</option>
              </select>
            </div>
          </div>
          <SubmitButton className="w-fit">Add staff</SubmitButton>
        </ToastForm>
      </Card>

      {staff.length === 0 ? (
        <EmptyState title="No staff yet" description="Add a manager or staff account above to give them dashboard access." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.email ?? s.phone}</TableCell>
                  <TableCell>
                    <ToastForm
                      action={setStaffRoleAction.bind(null, s.id, s.roleKey === "manager" ? "staff" : "manager")}
                      successMessage="Role updated"
                    >
                      <SubmitButton variant="outline" size="sm">
                        {s.roleKey === "manager" ? "Manager — make Staff" : "Staff — make Manager"}
                      </SubmitButton>
                    </ToastForm>
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.status === "active" ? "default" : "secondary"}>{s.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {s.status === "active" && (
                      <ConfirmActionButton
                        action={deactivateStaffAction.bind(null, s.id)}
                        label="Deactivate"
                        size="sm"
                        variant="ghost"
                        title={`Deactivate ${s.name}?`}
                        description="They'll be signed out immediately and won't be able to log in again."
                        successMessage="Staff member deactivated"
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
