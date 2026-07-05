import { LogoMark } from "@/components/brand/LogoMark";

export function Hero({
  name, logoUrl, coverImageUrl, primaryColor,
}: {
  name: string;
  logoUrl: string | null;
  coverImageUrl: string | null;
  primaryColor: string;
}) {
  return (
    <div
      className="relative flex h-64 w-full items-end overflow-hidden sm:h-80"
      style={!coverImageUrl ? { background: `linear-gradient(135deg, ${primaryColor}, #1A0F0A)` } : undefined}
    >
      {coverImageUrl && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={coverImageUrl} alt="" className="absolute inset-0 size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#17100B]/90 via-[#17100B]/20 to-transparent" />
        </>
      )}
      <div className="relative z-10 flex items-center gap-3 p-6">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={name} className="size-14 rounded-full border-2 border-white/80 object-cover shadow-lg" />
        ) : (
          <LogoMark className="size-14 text-white" />
        )}
        <h1 className="font-display text-3xl font-extrabold text-white drop-shadow-sm sm:text-4xl">{name}</h1>
      </div>
    </div>
  );
}
