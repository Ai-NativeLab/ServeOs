import { Phone, MessageCircle } from "lucide-react";
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
      <div className="mx-auto grid max-w-3xl gap-6 sm:grid-cols-3">
        {branch && (
          <div>
            <div className="eyebrow text-muted-foreground">Find us</div>
            <p className="mt-2 font-sans font-semibold text-ink">{branch.name}</p>
            {branch.address && <p className="mt-1 text-sm text-muted-foreground">{branch.address}</p>}
          </div>
        )}

        {branch && branch.openingHours.length > 0 && (
          <div>
            <div className="eyebrow text-muted-foreground">Hours</div>
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

        {/* Hoisted out of `branch &&` so a tenant with only a WhatsApp number (no
            resolvable branch) still renders a contact column instead of an empty shell. */}
        {(branch?.phone || whatsappNumber) && (
          <div>
            <div className="eyebrow text-muted-foreground">Get in touch</div>
            <div className="mt-2 flex flex-col gap-1.5">
              {branch?.phone && (
                <a
                  href={`tel:${branch.phone}`}
                  className="flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary/80"
                >
                  <Phone className="size-3.5 shrink-0" strokeWidth={1.75} />
                  {branch.phone}
                </a>
              )}
              {whatsappNumber && (
                <a
                  href={whatsappChatLink(whatsappNumber, "")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary/80"
                >
                  <MessageCircle className="size-3.5 shrink-0" strokeWidth={1.75} />
                  WhatsApp us
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </footer>
  );
}
