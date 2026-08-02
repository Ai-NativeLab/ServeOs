import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/** Rendered where an advanced section is entitlement-blocked (FeatureNotAvailableError). */
export function UpgradePrompt() {
  return (
    <Card className="p-8 text-center">
      <h2 className="font-display text-lg font-bold text-ink">Advanced reports are on the Enterprise plan</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Branch, cashier and payment-method breakdowns, financial reports, and
        inventory analytics come with the Enterprise plan.
      </p>
      <Button asChild className="mt-4">
        <Link href="/dashboard/settings/billing">View plans</Link>
      </Button>
    </Card>
  );
}
