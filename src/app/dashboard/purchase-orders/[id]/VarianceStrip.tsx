import { Card } from "@/components/ui/card";
import type { PoVariance } from "@/server/purchasing/variance";

export function VarianceStrip({
  variance,
  currency = "EGP",
}: {
  variance: PoVariance;
  currency?: string;
}) {
  const recDelta = Number(variance.receivedVsOrdered);
  const invDelta = variance.invoiceVsReceived !== null ? Number(variance.invoiceVsReceived) : null;

  return (
    <Card className="p-4 bg-muted/20 border-border/80">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Three-Way Match & Variance
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 divide-y sm:divide-y-0 sm:divide-x divide-border/60">
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Ordered Total</div>
          <div className="text-lg font-bold font-mono">
            {variance.total} {currency}
          </div>
          <div className="text-xs text-muted-foreground">Target value at send time</div>
        </div>

        <div className="space-y-1 sm:pl-4 pt-3 sm:pt-0">
          <div className="text-xs text-muted-foreground">Received Total</div>
          <div className="text-lg font-bold font-mono">
            {variance.receivedTotal} {currency}
          </div>
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <span>vs Ordered:</span>
            <span
              className={
                recDelta === 0
                  ? "text-muted-foreground"
                  : recDelta > 0
                  ? "text-amber-600"
                  : "text-blue-600"
              }
            >
              {recDelta > 0 ? `+${variance.receivedVsOrdered}` : variance.receivedVsOrdered} {currency}
            </span>
          </div>
        </div>

        <div className="space-y-1 sm:pl-4 pt-3 sm:pt-0">
          <div className="text-xs text-muted-foreground">Invoiced Total</div>
          {variance.invoiceTotal !== null ? (
            <>
              <div className="text-lg font-bold font-mono">
                {variance.invoiceTotal} {currency}
              </div>
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span>vs Received:</span>
                <span
                  className={
                    invDelta === 0
                      ? "text-green-600"
                      : invDelta && invDelta > 0
                      ? "text-red-600"
                      : "text-blue-600"
                  }
                >
                  {invDelta !== null && invDelta > 0
                    ? `+${variance.invoiceVsReceived}`
                    : variance.invoiceVsReceived}{" "}
                  {currency}
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-medium text-muted-foreground pt-1">
                Not entered yet
              </div>
              <div className="text-xs text-muted-foreground">
                Enter supplier invoice to check match
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
