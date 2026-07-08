import type { OpeningHours } from "@/server/branches/schema";
import { whatsappChatLink } from "@/lib/whatsapp";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function StorefrontFooter({
  branch, whatsappNumber,
}: {
  branch: { name: string; address: string | null; phone: string | null; openingHours: OpeningHours } | null;
  whatsappNumber: string | null;
}) {
  if (!branch && !whatsappNumber) return null;
  return (
    <footer className="mt-12 border-t border-border bg-card px-4 py-8 sm:px-6">
      <div className="mx-auto grid max-w-3xl gap-6 sm:grid-cols-2">
        {branch && (
          <div>
            <div className="eyebrow text-muted-foreground">Find us</div>
            <p className="mt-2 font-sans font-semibold text-ink">{branch.name}</p>
            {branch.address && <p className="text-sm text-muted-foreground">{branch.address}</p>}
            {branch.phone && (
              <a href={`tel:${branch.phone}`} className="mt-1 block text-sm font-medium text-primary">
                {branch.phone}
              </a>
            )}
            {whatsappNumber && (
              <a
                href={whatsappChatLink(whatsappNumber, "")}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block text-sm font-medium text-primary"
              >
                WhatsApp us
              </a>
            )}
          </div>
        )}
        {branch && branch.openingHours.length > 0 && (
          <div>
            <div className="eyebrow text-muted-foreground">Opening hours</div>
            <dl className="mt-2 space-y-1 text-sm">
              {branch.openingHours.map((h) => (
                <div key={h.day} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{DAYS[h.day]}</dt>
                  <dd className="font-mono text-ink">{h.closed ? "Closed" : `${h.open}–${h.close}`}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </footer>
  );
}
