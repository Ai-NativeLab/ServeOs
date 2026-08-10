import Link from "next/link";

export function Pagination({
  page,
  pageSize,
  total,
  buildHref,
}: {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (page: number) => string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  if (total === 0 || from > total) return null;

  const linkClass =
    "px-3 py-1.5 rounded-md border border-input text-sm hover:bg-muted";
  const disabledClass =
    "px-3 py-1.5 rounded-md border border-input text-sm text-muted-foreground/40";

  return (
    <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-sm">
      <span className="text-muted-foreground text-center sm:text-left">
        Showing {from}–{to} of {total}
      </span>
      <div className="flex items-center justify-center sm:justify-end gap-2">
        {page > 1 ? (
          <Link href={buildHref(page - 1)} className={linkClass}>
            ← Prev
          </Link>
        ) : (
          <span className={disabledClass}>← Prev</span>
        )}
        <span className="text-muted-foreground whitespace-nowrap">
          Page {page} of {totalPages}
        </span>
        {page < totalPages ? (
          <Link href={buildHref(page + 1)} className={linkClass}>
            Next →
          </Link>
        ) : (
          <span className={disabledClass}>Next →</span>
        )}
      </div>
    </div>
  );
}
