import { useState, type FormEvent } from "react";

/**
 * A staff cashier hands the terminal to a manager, who enters their OWN
 * credentials. The server checks the password and the permission, and returns
 * a single-use grant the sale then spends.
 */
export function ManagerAuthModal({
  permission,
  action,
  onGranted,
  onCancel,
}: {
  permission: string;
  action: string;
  onGranted: (grant: string, authorizedBy: string) => void;
  onCancel: () => void;
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
      const { grant, authorizedBy } = await window.pos.authorize(email.trim(), password, permission);
      onGranted(grant, authorizedBy);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authorization failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold text-ink">Manager approval needed</h2>
        <p className="mt-1 text-sm text-muted-foreground">{action}</p>

        <label className="mt-5 block text-sm font-medium text-ink" htmlFor="mgr-email">Manager email</label>
        <input
          id="mgr-email"
          type="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

        <label className="mt-4 block text-sm font-medium text-ink" htmlFor="mgr-password">Password</label>
        <input
          id="mgr-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-border bg-card px-4 py-3 font-semibold text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !email || !password}
            className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Checking…" : "Approve"}
          </button>
        </div>
      </form>
    </div>
  );
}
