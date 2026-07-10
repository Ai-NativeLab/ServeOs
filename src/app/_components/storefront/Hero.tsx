import { LogoMark } from "@/components/brand/LogoMark";

export function Hero({
  name, logoUrl, coverImageUrl, tagline, cuisine, area, openLabel, etaLabel, minOrderLabel,
}: {
  name: string; logoUrl: string | null; coverImageUrl: string | null;
  tagline?: string | null; cuisine?: string | null; area?: string | null;
  openLabel?: string | null; etaLabel?: string | null; minOrderLabel?: string | null;
}) {
  return (
    <header className="relative">
      <div className="relative h-52 w-full sm:h-64">
        {coverImageUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={coverImageUrl} alt="" width={1200} height={512} loading="eager" className="h-full w-full object-cover" />
          : <div className="h-full w-full bg-secondary" />}
        <div className="absolute inset-0 bg-gradient-to-b from-ink/10 to-ink/75" />
        <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6">
          <div className="flex flex-wrap gap-2">
            {openLabel && <span className="sf-chip">{openLabel}</span>}
            {etaLabel && <span className="sf-chip">{etaLabel}</span>}
            {minOrderLabel && <span className="sf-chip">{minOrderLabel}</span>}
          </div>
        </div>
      </div>
      <div className="relative -mt-9 flex items-end gap-3 px-4 sm:px-6">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" width={72} height={72} className="size-[72px] flex-none rounded-2xl border-4 border-background object-cover shadow-lg" />
        ) : (
          <LogoMark className="size-[72px] flex-none rounded-2xl border-4 border-background bg-background text-ink shadow-lg" />
        )}
        <div className="pb-1">
          <h1 className="font-display text-2xl font-extrabold leading-none text-ink sm:text-3xl">{name}</h1>
          {(cuisine || area || tagline) && (
            <p className="mt-1.5 text-sm text-muted-foreground">
              {[cuisine, area].filter(Boolean).join(" · ")}{tagline ? ` — ${tagline}` : ""}
            </p>
          )}
        </div>
      </div>
    </header>
  );
}
