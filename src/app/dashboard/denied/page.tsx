import { PermissionDenied } from "@/components/dashboard/PermissionDenied";
import { PageHeader } from "@/components/dashboard/PageHeader";

export default async function DeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  const { permission } = await searchParams;
  return (
    <>
      <PageHeader eyebrow="Access" title="Permission required" />
      <PermissionDenied permission={permission} />
    </>
  );
}
