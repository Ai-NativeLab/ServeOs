import Link from "next/link";
import { LogoMark } from "@/components/brand/LogoMark";
import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";

export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-sidebar-border bg-sidebar/85 text-sidebar-foreground backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="#hero" className="flex items-center gap-2">
          <LogoMark className="size-7 text-primary" />
          <Wordmark className="text-lg" />
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-8 text-sm font-medium text-sidebar-foreground/70 md:flex">
          <a href="#features" className="hover:text-sidebar-foreground">Features</a>
          <a href="#how-it-works" className="hover:text-sidebar-foreground">How it works</a>
        </nav>

        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="hidden text-sm font-medium text-sidebar-foreground/70 hover:text-sidebar-foreground md:inline"
          >
            Sign in
          </Link>
          <Button asChild size="sm">
            <Link href="/register">Get Started</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
