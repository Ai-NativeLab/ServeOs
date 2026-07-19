import { useState, type FormEvent } from "react";

export function CashierSignIn({
  branchName,
  onSignedIn,
}: {
  branchName: string;
  onSignedIn: (c: { name: string; permissions: string[] }) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await window.pos.signInCashier(email.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
        <h1 className="font-display text-xl font-bold">
          Serve<span className="text-primary">OS</span> POS
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{branchName} — sign in to start selling</p>

        <label className="mt-5 block text-sm font-medium text-ink" htmlFor="cashier-email">Email</label>
        <input
          id="cashier-email"
          type="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

        <label className="mt-4 block text-sm font-medium text-ink" htmlFor="cashier-password">Password</label>
        <input
          id="cashier-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

        <button
          type="submit"
          disabled={busy || !email || !password}
          className="mt-5 w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
