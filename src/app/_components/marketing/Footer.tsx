import { LogoMark } from "@/components/brand/LogoMark";
import { Wordmark } from "@/components/brand/Wordmark";

export function MarketingFooter() {
  return (
    <footer className="border-t px-6 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-2 text-ink">
          <LogoMark className="size-5 text-primary" />
          <Wordmark className="text-sm" />
        </div>
        <p className="text-sm text-muted-foreground">© 2026 ServeOS</p>
      </div>
    </footer>
  );
}
