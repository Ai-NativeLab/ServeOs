import { useState } from "react";

export function PairScreen({ onPaired }: { onPaired: (branchName: string) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length !== 8) {
      setError("Code must be 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await window.pos.pair(trimmed);
      onPaired(res.branchName);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background text-foreground px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-card border border-border p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-ink">Pair this device</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Enter the 8-character code from your dashboard POS devices page.
        </p>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={8}
          autoFocus
          placeholder="ABCDEFGH"
          className="mt-4 w-full rounded-xl border border-input bg-background px-4 py-3 text-center text-2xl font-mono tracking-[0.3em] uppercase text-ink outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-4 w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Pairing…" : "Pair"}
        </button>
        {error && <p className="mt-3 text-sm text-status-danger-fg">{error}</p>}
      </form>
    </div>
  );
}
