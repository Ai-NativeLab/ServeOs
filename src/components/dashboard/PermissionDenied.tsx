import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PermissionDenied({
  permission,
  title = "Permission required",
  description,
}: {
  permission?: string;
  title?: string;
  description?: string;
}) {
  return (
    <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 px-6 text-center shadow-xs">
      <div className="flex size-12 items-center justify-center rounded-full bg-status-pending/10 text-status-pending mb-4 mx-auto">
        <ShieldAlert className="size-6" />
      </div>
      <h3 className="font-display text-lg font-bold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        {description ??
          (permission
            ? `Accessing this section requires the "${permission}" permission. Please contact your administrator if you need access.`
            : "You do not have permission to access this section. Please contact your administrator.")}
      </p>
      <div className="mt-6">
        <Button asChild variant="outline">
          <Link href="/dashboard/orders">Back to Dashboard →</Link>
        </Button>
      </div>
    </div>
  );
}
