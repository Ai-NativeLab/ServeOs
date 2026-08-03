import { requireRxReviewPermission } from "../rx-permission";
import { listPendingPrescriptions } from "@/server/prescriptions/service";
import { signedPrescriptionUrl } from "@/server/prescriptions/storage";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { ReviewForm } from "./ReviewForm";

export default async function PrescriptionsPage() {
  const ctx = await requireRxReviewPermission();
  const pending = await listPendingPrescriptions(ctx.tenantId);

  // Signed per render, expiring in minutes — a script URL that leaks stops
  // working quickly rather than living forever in a browser history.
  const withUrls = await Promise.all(
    pending.map(async (rx) => ({ rx, url: await signedPrescriptionUrl(rx.imagePath) })),
  );

  return (
    <>
      <PageHeader
        eyebrow="Pharmacy"
        title="Prescription review"
        description="Scripts waiting on a pharmacist before their order can be released."
      />
      {withUrls.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="Prescriptions customers upload will appear here for review."
        />
      ) : (
        <div className="space-y-4">
          {withUrls.map(({ rx, url }) => (
            <Card key={rx.id} className="flex flex-col gap-4 p-5 sm:flex-row">
              <div className="sm:w-64 shrink-0">
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url} alt="Prescription"
                      className="max-h-56 w-full rounded-lg border border-border object-contain bg-secondary"
                    />
                  </a>
                ) : (
                  <div className="grid h-40 place-items-center rounded-lg border border-dashed text-xs text-muted-foreground">
                    Preview unavailable
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Submitted {rx.createdAt.toLocaleString()}
                  </p>
                  {rx.orderId && (
                    <p className="text-sm text-ink">
                      Attached to an order — approving releases it for fulfilment.
                    </p>
                  )}
                </div>
                <ReviewForm prescriptionId={rx.id} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
