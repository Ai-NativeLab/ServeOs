import { useEffect, useState } from "react";
import { formatAmount } from "../drawer/counting";
import type { DayZReport } from "../../electron/pos-main";
import { ReportCard, HeroStat, ReportRows } from "./XReport";

/**
 * The Z report — the close's numbers, styled to the ServeOS POS design page:
 * same dark till card as X, coral "end of day" pill, counted-vs-expected
 * block once the drawer has been counted. Freezing happens in the drawer's
 * close flow (Spec 2); this screen only reads.
 */
export function ZReportScreen() {
  const [report, setReport] = useState<DayZReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.pos.zReport().then((r) => {
      setReport(r);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return <div className="grid place-items-center py-24 text-sm text-muted-foreground">Building Z report…</div>;
  }
  if (!report) {
    return (
      <div className="grid place-items-center py-24 text-sm text-muted-foreground">
        No report available — sign in first.
      </div>
    );
  }

  const day = new Date(report.window.from).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  const counted = report.countedCash;
  const overShort = report.overShort;

  return (
    <ReportCard
      title="Z report"
      pill={
        report.frozen
          ? { label: "end of day", tone: "coral" }
          : report.shiftId
            ? { label: "shift open", tone: "teal" }
            : { label: "no shift", tone: "muted" }
      }
      meta={`${day} · ${time(report.window.from)} → ${time(report.window.to)}`}
    >
      <HeroStat label="Net sales" value={report.grossSales} />
      <ReportRows report={report} />

      {counted === null ? (
        <div className="mt-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm leading-relaxed text-[#FBF1EC]/60">
          {report.shiftId
            ? "Not counted yet — close the drawer to count the cash and freeze this Z."
            : "No shift on this till — open a drawer to tie a Z report to a shift."}
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-1.5 rounded-xl border border-[#F0522B]/25 bg-[#F0522B]/10 px-4 py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[#FF9070]">Counted cash</span>
            <span className="font-mono font-bold text-[#FBF1EC]">{formatAmount(counted)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-[#FF9070]">Over / short</span>
            <span className={`font-mono font-bold ${overShort === 0 ? "text-[#38D08C]" : "text-[#F26D5F]"}`}>
              {overShort !== null && overShort > 0 ? "+" : ""}
              {formatAmount(overShort ?? 0)}
            </span>
          </div>
          {report.frozen && (
            <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-[#FBF1EC]/40">
              Frozen at shift close
            </div>
          )}
        </div>
      )}
    </ReportCard>
  );
}
