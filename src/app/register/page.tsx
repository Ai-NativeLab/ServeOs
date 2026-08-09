import Link from "next/link";
import { LogoMark } from "@/components/brand/LogoMark";
import { RegisterForm } from "./RegisterForm";

export default function RegisterPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[400px] rounded-2xl border bg-card p-8 shadow-card">
        <Link href="/" className="mb-7 flex items-center gap-2.5">
          <LogoMark className="size-6 text-primary" />
          <span className="font-display text-base font-bold text-ink">ServeOS</span>
        </Link>

        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">Create your store</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Start your free trial. No credit card required.
        </p>

        <RegisterForm />

        <p className="mt-5 text-center text-[13px] text-muted-foreground">
          Already have an account?{" "}
          <a href="/login" className="text-primary">
            Sign in →
          </a>
        </p>
      </div>
    </main>
  );
}
