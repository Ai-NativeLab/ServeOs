import { headers } from "next/headers";
import { getTenantBySlug } from "@/server/tenancy";
import { getOrderByToken } from "@/server/ordering/service";
import { StatusPoller } from "./StatusPoller";

const STEPS_DELIVERY = ["pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed"];
const STEPS_PICKUP = ["pending", "confirmed", "preparing", "ready", "completed"];

export default async function OrderStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const slug = h.get("x-tenant-slug");
  if (!slug) return <main style={{ padding: 32 }}><h1>Not found</h1></main>;

  const tenant = await getTenantBySlug(slug);
  const order = tenant ? await getOrderByToken(tenant.id, token) : null;
  if (!order) return <main style={{ padding: 32, fontFamily: "system-ui" }}><h1>Order not found</h1></main>;

  const steps = order.fulfillmentType === "delivery" ? STEPS_DELIVERY : STEPS_PICKUP;

  return (
    <main style={{ padding: 24, maxWidth: 440, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22 }}>Order #{order.orderNumber}</h1>
      <StatusPoller token={token} slug={slug} initialStatus={order.status} steps={steps} terminal={["completed", "rejected", "cancelled"]} />
      <div style={{ borderTop: "1px solid #eee", marginTop: 16, paddingTop: 12, fontSize: 14, color: "#374151" }}>
        <div>{order.fulfillmentType === "delivery" ? `Delivery to ${order.deliveryAreaNameSnapshot ?? ""}` : "Pickup"} · Cash · {order.paymentStatus}</div>
        {order.items.map((it) => <div key={it.id}>{it.quantity}× {it.nameEn}</div>)}
        <div style={{ fontWeight: 700, marginTop: 6 }}>Total {Number(order.total).toFixed(2)}</div>
      </div>
    </main>
  );
}
