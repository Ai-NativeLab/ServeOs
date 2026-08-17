import Link from "next/link";
import { getDemoEntry } from "@/server/demo/entry";
import { VERTICAL_ACCENTS, type VerticalId } from "@/server/verticals";

export function DemoCard({
  trade, label, openStorefront, openDashboard,
}: {
  trade: VerticalId;
  label: string;
  openStorefront: string;
  openDashboard: string;
}) {
  const { storefrontUrl, dashboardUrl } = getDemoEntry(trade);
  const accent = VERTICAL_ACCENTS[trade];

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
      <span
        className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs"
        style={{ backgroundColor: `${accent}1F`, color: accent }}
      >
        <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: accent }} />
        {label}
      </span>

      <div className="mt-5 flex flex-col gap-2">
        {/* A plain anchor, not next/link — this is a different origin, and
            Link would attempt a prefetch that cannot succeed. */}
        <a
          href={storefrontUrl}
          className="rounded-md px-4 py-2.5 text-center text-sm font-medium text-[#14120F]"
          style={{ backgroundColor: accent }}
        >
          {openStorefront}
        </a>
        <Link
          href={dashboardUrl}
          className="rounded-md border border-white/20 px-4 py-2.5 text-center text-sm text-white/90 hover:bg-white/5"
        >
          {openDashboard}
        </Link>
      </div>
    </div>
  );
}
