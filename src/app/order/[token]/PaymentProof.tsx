"use client";
import { useRef, useState } from "react";
import { IMAGE_ACCEPT_ATTR, MAX_UPLOAD_BYTES } from "@/lib/upload-limits";

/**
 * Lets the customer attach a transfer screenshot after placing the order.
 *
 * The copy is deliberate: nothing here says "verify". ServeOS has no
 * connection to InstaPay, Vodafone Cash or any wallet — the shop checks its
 * own account and decides. Promising otherwise would be the one thing this
 * screen must not do.
 */
export function PaymentProof({
  token,
  slug,
  methodLabel,
  initialUrl,
}: {
  token: string;
  slug: string;
  methodLabel: string;
  initialUrl: string | null;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("That image is too large (max 5 MB).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch(`/api/orders/${token}/proof?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        body,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not attach that image.");
        return;
      }
      setUrl(data.url);
    } catch {
      setError("Could not attach that image.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section className="card-lift mt-4 rounded-2xl border border-border bg-card p-5 text-sm">
      <div className="eyebrow text-muted-foreground">Payment</div>
      <p className="mt-1.5 text-ink">
        You paid by {methodLabel}. The shop checks its own account and confirms — your order starts
        once they do.
      </p>

      {url ? (
        <p className="mt-3 text-muted-foreground">
          Screenshot attached.{" "}
          <a href={url} target="_blank" rel="noreferrer" className="text-primary underline">
            View
          </a>
        </p>
      ) : (
        <>
          <p className="mt-3 text-muted-foreground">
            Attaching a screenshot of the transfer is optional, and can save a phone call.
          </p>
          <label className="mt-2 inline-flex cursor-pointer items-center rounded-full border border-border px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-muted">
            {busy ? "Attaching…" : "Attach screenshot"}
            <input
              ref={inputRef}
              type="file"
              accept={IMAGE_ACCEPT_ATTR}
              disabled={busy}
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
        </>
      )}

      {error && <p className="mt-2 text-destructive">{error}</p>}
    </section>
  );
}
