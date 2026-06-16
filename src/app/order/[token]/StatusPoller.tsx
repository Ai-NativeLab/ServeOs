"use client";
import { useEffect, useRef, useState } from "react";

export function StatusPoller({ token, slug, initialStatus, steps, terminal }: { token: string; slug: string; initialStatus: string; steps: string[]; terminal: string[] }) {
  const [status, setStatus] = useState(initialStatus);
  const terminalRef = useRef(terminal);

  useEffect(() => {
    if (terminalRef.current.includes(status)) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/orders/${token}/status?slug=${encodeURIComponent(slug)}`);
        if (res.ok) {
          const data = await res.json();
          setStatus(data.status);
          if (terminalRef.current.includes(data.status)) clearInterval(id);
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(id);
  }, [token, slug, status]);

  const label = (s: string) => s.replace(/_/g, " ");
  const currentIdx = steps.indexOf(status);
  const isCancelled = status === "cancelled" || status === "rejected";

  return (
    <div style={{ marginTop: 12 }}>
      {isCancelled ? (
        <div style={{ color: "#b91c1c", fontWeight: 700, textTransform: "capitalize" }}>{label(status)}</div>
      ) : (
        steps.map((s, i) => (
          <div key={s} style={{ opacity: i <= currentIdx ? 1 : 0.4, fontWeight: i === currentIdx ? 700 : 400, textTransform: "capitalize", padding: "2px 0" }}>
            {i < currentIdx ? "✅ " : i === currentIdx ? "🟣 " : "⚪ "}{label(s)}
          </div>
        ))
      )}
    </div>
  );
}
