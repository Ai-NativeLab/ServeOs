import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle, Clock, XCircle, CreditCard, Mail, LogOut } from "lucide-react";
import Link from "next/link";
import { signOutAction } from "@/app/dashboard/actions";

type SearchParams = Promise<{ status?: string }>;

export default async function LockoutPage({ searchParams }: { searchParams: SearchParams }) {
  const { tenant } = await requireDashboardUser({
    allowStatus: ["onboarding", "suspended", "rejected"],
  });

  const params = await searchParams;
  const status = params.status || tenant.status;

  const contentMap = {
    suspended: {
      icon: AlertCircle,
      iconBg: "bg-amber-500/10 text-amber-500 border-amber-500/20",
      title: "Account Suspended",
      badge: "Suspended",
      badgeClass: "bg-amber-500/10 text-amber-500 border-amber-500/30",
      description:
        "Your restaurant dashboard and storefront have been temporarily suspended. This may be due to an outstanding invoice or account review.",
      actionText: "If your suspension is due to billing, you can view invoices and submit payment proof in billing settings.",
      showBilling: true,
    },
    rejected: {
      icon: XCircle,
      iconBg: "bg-destructive/10 text-destructive border-destructive/20",
      title: "Application Not Approved",
      badge: "Rejected",
      badgeClass: "bg-destructive/10 text-destructive border-destructive/30",
      description:
        "Your store registration could not be approved at this time. Merchant dashboard features and customer ordering are inactive.",
      actionText: "If you believe this is a mistake or have questions regarding eligibility, please contact our support team.",
      showBilling: false,
    },
    onboarding: {
      icon: Clock,
      iconBg: "bg-blue-500/10 text-blue-500 border-blue-500/20",
      title: "Application Under Review",
      badge: "Pending Approval",
      badgeClass: "bg-blue-500/10 text-blue-500 border-blue-500/30",
      description:
        "Your account is currently being reviewed by our team. You will receive an email once your store has been approved and activated.",
      actionText: "Once approved, full access to your merchant dashboard and digital storefront will be restored immediately.",
      showBilling: false,
    },
  };

  const activeContent =
    contentMap[status as keyof typeof contentMap] ?? contentMap.suspended;
  const Icon = activeContent.icon;

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-4">
      <Card className="max-w-lg w-full shadow-lg border-border">
        <CardHeader className="text-center pb-4">
          <div className={`mx-auto mb-4 flex size-14 items-center justify-center rounded-full border shadow-sm ${activeContent.iconBg}`}>
            <Icon className="size-7" />
          </div>
          <div className="flex items-center justify-center gap-2 mb-2">
            <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${activeContent.badgeClass}`}>
              {activeContent.badge}
            </span>
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">
            {activeContent.title}
          </CardTitle>
          <CardDescription className="text-base mt-2 text-muted-foreground">
            {activeContent.description}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground border-y py-4 my-2">
          <p>{activeContent.actionText}</p>
          <div className="rounded-md bg-muted p-3 text-xs flex items-center justify-between">
            <span className="font-medium text-foreground">Restaurant:</span>
            <span>{tenant.name}</span>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col sm:flex-row gap-3 pt-4">
          {activeContent.showBilling && (
            <Button asChild className="w-full sm:w-auto flex-1 gap-2">
              <Link href="/dashboard/settings/billing">
                <CreditCard className="size-4" />
                Go to Billing
              </Link>
            </Button>
          )}
          <Button asChild variant="outline" className="w-full sm:w-auto flex-1 gap-2">
            {/* No mailto: no platform support address exists yet. Reachable
                wording beats an invented address that bounces. */}
            <a href="https://serveos.tech" target="_blank" rel="noreferrer">
              <Mail className="size-4" />
              Contact Support
            </a>
          </Button>
          <form action={signOutAction} className="w-full sm:w-auto">
            <Button variant="ghost" type="submit" className="w-full gap-2 text-muted-foreground hover:text-foreground">
              <LogOut className="size-4" />
              Sign Out
            </Button>
          </form>
        </CardFooter>
      </Card>
    </div>
  );
}
