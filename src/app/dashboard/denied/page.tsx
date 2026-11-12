import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { PermissionDenied } from "@/components/dashboard/PermissionDenied";
import { PageHeader } from "@/components/dashboard/PageHeader";

/** The one page every signed-in user may see: it needs a session (the gate
 *  every dashboard page carries) but deliberately no permission — it IS the
 *  permission-refusal screen the require*Permission wrappers redirect to. */
export default async function DeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  await requireDashboardUser();
  const { permission } = await searchParams;
  return (
    <>
      <PageHeader eyebrow="Access" title="Permission required" />
      <PermissionDenied permission={permission} />
    </>
  );
}
