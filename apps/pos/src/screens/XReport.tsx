import { useCallback, useEffect, useState } from "react";
import { formatAmount } from "../drawer/counting";
import type { DayReport } from "../../electron/pos-main";

/**
 * The X report — a mid-shift peek, styled to the ServeOS POS design page
 * ("06 · X/Z reports"): dark till card, teal "shift open" pill, mono
 * metadata, hero net-sales stat. Reading it changes nothing on the server,
 * so Refresh is always safe.
 */
export function XReportScreen() {
  const [report, setReport] = useState<DayReport | null>(null);
  const [loading, setLoading] = useState(true);

  // State settles inside the promise continuation, never synchronously in the
  // effect — same discipline as DrawerScreen. Refresh updates in place; the
  // server records nothing, so re-pulling is always safe.
  const refresh = useCallback(
    () =>
      window.pos.xReport().then((r) => {
        setReport(r);
        setLoading(false);
      }),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) {
    return <div className="grid place-items-center py-24 text-sm text-muted-foreground">Building X report…</div>;
  }
  if (!report) {
    return (
      <div className="grid place-items-center py-24 text-sm text-muted-foreground">
        No report available — sign in and ring a sale first.
      </div>
    );
  }

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <ReportCard
      title="X report"
      pill={{ label: "shift open", tone: "teal" }}
      meta={`Mid-shift snapshot · nothing is closed · ${time(report.window.from)} → ${time(report.window.to)}`}
      footer={
        <button
          onClick={() => void refresh()}
          className="mt-auto flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 text-sm font-semibold text-[#FBF1EC]/90 hover:bg-white/10"
        >
          Refresh — pulling it changes nothing
        </button>
      }
    >
      <HeroStat label="Net sales so far" value={report.grossSales} />
      <ReportRows report={report} />
      <ExpectedCash value={report.expectedDrawerCash} />
    </ReportCard>
  );
}

/* Shared pieces for the X and Z screens — one dark till card, per the design. */

export function ReportCard({
  title, pill, meta, children, footer,
}: {
  title: string;
  pill: { label: string; tone: "teal" | "coral" | "muted" };
  meta: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const pillClass = {
    teal: "bg-[#2DD4C4]/15 text-[#5EEBDD] border-[#2DD4C4]/25",
    coral: "bg-[#F0522B]/15 text-[#FF9070] border-[#F0522B]/30",
    muted: "bg-white/10 text-[#FBF1EC]/60 border-white/15",
  }[pill.tone];

  return (
    <div className="mx-auto my-8 flex min-h-[520px] w-full max-w-xl flex-col rounded-2xl bg-[#140D08] p-6 shadow-[0_26px_56px_-32px_rgba(20,13,8,.6),0_0_0_1px_rgba(255,255,255,.06)]">
      <div className="mb-1 flex items-center justify-between">
        <div className="font-display text-lg font-bold tracking-tight text-[#FBF1EC]">{title}</div>
        <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ${pillClass}`}>
          {pill.label}
        </span>
      </div>
      <div className="mb-4 font-mono text-[10.5px] text-[#FBF1EC]/40">{meta}</div>
      {children}
      {footer}
    </div>
  );
}

export function HeroStat({ label, value }: { label: string; value: number }) {
  const [whole, cents] = formatAmount(value).split(".");
  return (
    <div className="mb-3 rounded-xl border border-white/10 bg-gradient-to-br from-[#241A13] to-[#180F09] px-4 py-4 shadow-[0_1px_0_rgba(255,255,255,.07)_inset]">
      <div className="mb-1 text-xs text-[#FBF1EC]/45">{label}</div>
      <div className="font-display text-3xl font-extrabold leading-none tracking-tight text-[#FBF1EC]">
        {whole}
        <span className="text-xl text-[#FBF1EC]/40">.{cents}</span>
      </div>
    </div>
  );
}

export function ReportRows({ report }: { report: DayReport }) {
  const row = (label: string, value: string, key?: string) => (
    <div key={key ?? label} className="flex items-center justify-between border-b border-white/5 py-1.5 text-sm">
      <span className="text-[#FBF1EC]/70">{label}</span>
      <span className="font-mono text-[#FBF1EC]/90">{value}</span>
    </div>
  );
  return (
    <div className="flex flex-col">
      {row("Orders", String(report.orderCount))}
      {report.tenders.map((t) => row(t.method === "cash" ? "Cash" : t.method === "card" ? "Card" : "Other", formatAmount(t.amount), `tender-${t.method}`))}
      {row("Tips", formatAmount(report.tips))}
      {row("Discounts", formatAmount(report.discounts))}
      {row("Voids", formatAmount(report.voids))}
      {row("Refunds", formatAmount(report.refunds))}
      {report.perCashier.map((c) =>
        row(c.cashierName ?? "Unknown cashier", `${formatAmount(c.sales)} · ${c.orders} orders`, `cashier-${c.cashierUserId}`),
      )}
    </div>
  );
}

export function ExpectedCash({ value }: { value: number }) {
  return (
    <div className="mt-3 flex items-center justify-between rounded-xl border border-[#2DD4C4]/25 bg-[#2DD4C4]/10 px-4 py-3">
      <span className="text-sm font-medium text-[#9EEDE4]">Expected drawer cash</span>
      <span className="font-mono text-base font-bold text-[#5EEBDD]">{formatAmount(value)}</span>
    </div>
  );
}
