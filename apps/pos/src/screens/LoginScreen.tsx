import { useState } from "react";

type Branch = { id: string; name: string };

export function LoginScreen({ onPaired }: { onPaired: (branchName: string) => void }) {
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function attempt(branchId?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await window.pos.login(slug.trim(), email.trim(), password, branchId);
      if (res.status === "branch_required") {
        setBranches(res.branches);
      } else {
        onPaired(res.branchName);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug.trim() || !email.trim() || !password) {
      setError("Enter your restaurant, email, and password.");
      return;
    }
    await attempt();
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background text-foreground px-4">
      <div className="w-full max-w-sm rounded-2xl bg-card border border-border p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-ink">
          Sign in to <span className="font-display">Serve<span className="text-primary">OS</span></span> POS
        </h1>

        {branches ? (
          <>
            <p className="text-sm text-muted-foreground mt-1">Choose this device's branch.</p>
            <div className="mt-4 grid gap-2">
              {branches.map((b) => (
                <button
                  key={b.id}
                  disabled={busy}
                  onClick={() => attempt(b.id)}
                  className="w-full rounded-xl border border-input bg-background px-4 py-3 text-left font-medium text-ink hover:bg-secondary disabled:opacity-50"
                >
                  {b.name}
                </button>
              ))}
            </div>
            <button
              onClick={() => { setBranches(null); setError(null); }}
              className="mt-4 text-sm text-muted-foreground hover:text-ink"
            >
              ← Back
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="text-sm text-muted-foreground mt-1">
              Use your ServeOS staff account. This device stays signed in.
            </p>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              autoFocus
              autoCapitalize="none"
              placeholder="Restaurant (e.g. roma)"
              className="mt-4 w-full rounded-xl border border-input bg-background px-4 py-3 text-ink outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoCapitalize="none"
              placeholder="Email"
              className="mt-3 w-full rounded-xl border border-input bg-background px-4 py-3 text-ink outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="mt-3 w-full rounded-xl border border-input bg-background px-4 py-3 text-ink outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        {error && <p className="mt-3 text-sm text-status-danger-fg">{error}</p>}
      </div>
    </div>
  );
}
