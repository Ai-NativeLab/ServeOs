"use client";
import { useEffect, useState } from "react";

type Row = { id: string; orderNumber: number; customerName: string; fulfillmentType: string; total: string; status: string; paymentStatus: string };

export function OrdersTable({ initial }: { initial: Row[] }) {
  const [rows, setRows] = useState<Row[]>(initial);
  const pending = rows.filter((r) => r.status === "pending").length;

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/dashboard/orders", { cache: "no-store" });
        if (res.ok) setRows(await res.json());
      } catch { /* keep polling */ }
    }, 8000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <div style={{ margin: "8px 0" }}>
        {pending > 0 && <span style={{ background: "#b91c1c", color: "#fff", borderRadius: 10, padding: "2px 10px", fontSize: 13 }}>{pending} new</span>}
        <span style={{ color: "#6b7280", fontSize: 12, marginInlineStart: 8 }}>auto-refreshing · 🛵 delivery · 🥡 pickup</span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "start", color: "#6b7280", fontSize: 13 }}><th style={{ textAlign: "start" }}>#</th><th style={{ textAlign: "start" }}>Customer</th><th>Type</th><th>Total</th><th>Payment</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ background: r.status === "pending" ? "#fff7ed" : undefined, borderTop: "1px solid #eee" }}>
              <td><a href={`/dashboard/orders/${r.id}`}>{r.orderNumber}</a></td>
              <td>{r.customerName}</td>
              <td style={{ textAlign: "center" }}>{r.fulfillmentType === "delivery" ? "🛵" : "🥡"}</td>
              <td style={{ textAlign: "center" }}>{Number(r.total).toFixed(2)}</td>
              <td style={{ textAlign: "center", color: r.paymentStatus === "paid" ? "#15803d" : "#b91c1c" }}>{r.paymentStatus}</td>
              <td style={{ textAlign: "center", textTransform: "capitalize" }}>{r.status.replace(/_/g, " ")}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} style={{ color: "#6b7280", padding: 12 }}>No orders yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
