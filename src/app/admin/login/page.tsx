import Link from "next/link";
import { LogoMark } from "@/components/brand/LogoMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminLoginAction } from "./actions";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[400px] rounded-2xl border bg-card p-8 shadow-card">
        <Link href="/" className="mb-7 flex items-center gap-2.5">
          <LogoMark className="size-6 text-primary" />
          <span className="font-display text-base font-bold text-ink">ServeOS</span>
        </Link>

        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">Platform admin</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Sign in to the ServeOS admin console
        </p>

        {error && (
          <p className="mb-4 text-sm text-destructive">
            {error === "not_admin"
              ? "That account is not a platform admin. Retyping the password will not help — it needs the super admin role."
              : "Invalid email or password."}
          </p>
        )}

        <form action={adminLoginAction} className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Email</span>
            <Input name="email" type="email" placeholder="admin@serveos.com" required />
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
          Restaurant owner?{" "}
          <a href="/login" className="text-primary">
            Sign in here →
          </a>
        </p>
      </div>
    </main>
  );
}
