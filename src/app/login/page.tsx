import Link from "next/link";
import { LogoMark } from "@/components/brand/LogoMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loginAction } from "./actions";
import { DEFAULT_NEXT, safeNext } from "./safe-next";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next: rawNext } = await searchParams;
  // Sanitised here as well as in loginAction. The action is what actually
  // guards the redirect, but echoing an attacker's "https://evil.example"
  // straight back into a hidden field puts a hostile value in the DOM and
  // invites the next reader to trust it. Both ends run the same guard.
  const next = safeNext(rawNext);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[400px] rounded-2xl border bg-card p-8 shadow-card">
        <Link href="/" className="mb-7 flex items-center gap-2.5">
          <LogoMark className="size-6 text-primary" />
          <span className="font-display text-base font-bold text-ink">ServeOS</span>
        </Link>

        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">Welcome back</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Sign in to your restaurant dashboard
        </p>

        {error && (
          <p className="mb-4 text-sm text-destructive">
            Invalid restaurant, email, or password.
          </p>
        )}

        <form action={loginAction} className="grid gap-4">
          {/* Carries the intended destination through the round trip — someone
              who came here from a pricing CTA gets taken to that plan, not
              dumped on the dashboard. loginAction re-validates it; a `next`
              that is not a same-site path is discarded there, not here. */}
          {next !== DEFAULT_NEXT && <input type="hidden" name="next" value={next} />}
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Restaurant</span>
            <Input name="slug" placeholder="e.g. roma" required />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Email</span>
            <Input name="email" type="email" placeholder="you@example.com" required />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Password</span>
            <Input name="password" type="password" placeholder="••••••••" required />
          </label>
          <Button type="submit" className="mt-2 w-full shadow-[0_16px_32px_-16px_rgba(240,82,43,0.8)]">
            Sign in
          </Button>
        </form>

        <p className="mt-5 text-center text-[13px] text-muted-foreground">
          Don{"'"}t have an account?{" "}
          <a href="/register" className="text-primary">
            Get started →
          </a>
        </p>
      </div>
    </main>
  );
}
