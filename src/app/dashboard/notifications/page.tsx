import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { listNotifications } from "@/server/notifications/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { MarkAllReadButton } from "./MarkAllReadButton";

const SEVERITY_BADGE: Record<string, string> = {
  info: "bg-secondary text-muted-foreground",
  warning: "bg-status-pending/20 text-status-pending-fg",
  critical: "bg-status-danger/15 text-status-danger-fg",
};

export default async function NotificationsPage() {
  const ctx = await requireDashboardUser();
  const { notifications, unreadCount } = await listNotifications(ctx.tenantId, ctx.user.id, ctx.roleKeys);

  return (
    <>
      <PageHeader
        eyebrow="Activity"
        title="Notifications"
        description="What the system wants you to know — alerts, variances, deliveries."
        action={unreadCount > 0 ? <MarkAllReadButton /> : undefined}
      />
      {notifications.length === 0 ? (
        <EmptyState
          title="Nothing yet"
          description="Low-stock alerts, shift variances and delivery updates will land here."
        />
      ) : (
        <Card className="divide-y p-0">
          {notifications.map((n) => (
            <div key={n.id} className={`flex items-start gap-3 px-5 py-4 ${n.readAt ? "opacity-60" : ""}`}>
              <span className={`mt-0.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${SEVERITY_BADGE[n.severity]}`}>
                {n.severity}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-medium text-ink">{n.title}</p>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {n.createdAt.toLocaleString()}
                  </time>
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p>
              </div>
              {!n.readAt && <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
