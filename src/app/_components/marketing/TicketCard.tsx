"use client";
import { useVertical } from "./VerticalProvider";

/**
 * The same docket, four trades — this card is the pitch, so it must never resize
 * when the vertical changes. The line block holds a fixed min-height and every
 * vertical supplies exactly two lines.
 */
export function TicketCard() {
  const { id, v, accent } = useVertical();

  return (
    <div
      key={id}
      data-testid="ticket"
      className="w-full rounded-2xl border border-black/5 bg-[#FFFDFB] p-5 text-[#1A0F0A] shadow-[0_28px_60px_-24px_rgba(0,0,0,0.55)] motion-safe:animate-[ticket-in_240ms_ease-out] sm:p-6"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display truncate text-lg font-bold">{v.ticket.ref}</span>
        <span className="eyebrow shrink-0" style={{ color: accent }}>
          {v.ticket.channel}
        </span>
      </div>

      {/* Sized for the worst case — timber's dimension meta wraps to two lines on a narrow
          viewport — so the card holds one height across all four trades. */}
      <div className="mt-4 min-h-[9.75rem] space-y-3 border-y border-dashed border-black/10 py-4">
        {v.ticket.lines.map((line, i) => (
          <div key={i} className="flex items-start justify-between gap-3">
            <span className="w-8 shrink-0 font-mono text-sm text-[#948676] tabular-nums">{line.qty}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{line.name}</p>
              <p className="mt-0.5 font-mono text-xs leading-relaxed text-[#948676]">{line.meta}</p>
            </div>
            <span className="shrink-0 font-mono text-sm tabular-nums">{line.amount}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <span
          className="inline-flex items-center gap-1.5 truncate rounded-full px-2.5 py-1 text-xs font-medium"
          style={{ backgroundColor: `${accent}1F`, color: shade(accent) }}
        >
          <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
          {v.ticket.status}
        </span>
        <span className="shrink-0 font-mono text-base font-bold tabular-nums">{v.ticket.total}</span>
      </div>
    </div>
  );
}

/** The raw accents are tuned for a dark hero; on the light card they need darkening to hold contrast. */
function shade(accent: string): string {
  const map: Record<string, string> = {
    "#F0522B": "#B33718",
    "#2DD4C4": "#0B7A70",
    "#38D08C": "#177A4F",
    "#E8A33D": "#8F6410",
  };
  return map[accent] ?? "#1A0F0A";
}
