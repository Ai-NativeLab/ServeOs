import { requireFulfillmentPermission } from "../fulfillment-permission";
import { listBranches, listDeliveryAreasForTenant } from "@/server/branches/service";
import { getVatRate } from "@/server/tenancy/settings";
import { setAcceptingOrdersAction, setOpeningHoursAction, addAreaAction, deleteAreaAction, setVatAction } from "./actions";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function FulfillmentPage() {
  const { tenantId } = await requireFulfillmentPermission();
  const [branches, vatRate, allAreas] = await Promise.all([
    listBranches(tenantId),
    getVatRate(tenantId),
    listDeliveryAreasForTenant(tenantId),
  ]);
  const areasByBranch = allAreas.reduce<Record<string, typeof allAreas>>((acc, a) => {
    (acc[a.branchId] ??= []).push(a);
    return acc;
  }, {});

  return (
    <main style={{ padding: 32, fontFamily: "system-ui", maxWidth: 720 }}>
      <h1>Ordering settings</h1>

      <section style={{ margin: "16px 0" }}>
        <h2 style={{ fontSize: 16 }}>VAT</h2>
        <form action={setVatAction} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input name="vatRate" type="number" step="0.1" defaultValue={vatRate} style={{ width: 100, padding: 6 }} /> %
          <button>Save</button>
        </form>
      </section>

      {branches.map((b) => {
        const hours = b.openingHours ?? [];
        const byDay = (d: number) => hours.find((h) => h.day === d);
        return (
          <section key={b.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <h2 style={{ fontSize: 16 }}>{b.name}</h2>

            <form action={setAcceptingOrdersAction.bind(null, b.id, !b.acceptingOrders)}>
              <button>{b.acceptingOrders ? "● Accepting orders (click to pause)" : "○ Paused (click to resume)"}</button>
            </form>

            <form action={setOpeningHoursAction.bind(null, b.id)} style={{ marginTop: 12 }}>
              <table style={{ fontSize: 13 }}>
                <tbody>
                  {DAYS.map((name, d) => {
                    const e = byDay(d);
                    return (
                      <tr key={d}>
                        <td>{name}</td>
                        <td><label><input type="checkbox" name={`closed-${d}`} defaultChecked={e?.closed ?? false} /> closed</label></td>
                        <td><input type="time" name={`open-${d}`} defaultValue={e?.open ?? "10:00"} /></td>
                        <td><input type="time" name={`close-${d}`} defaultValue={e?.close ?? "23:00"} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button style={{ marginTop: 6 }}>Save hours</button>
            </form>

            <h3 style={{ fontSize: 14, marginTop: 12 }}>Delivery areas</h3>
            <ul>
              {(areasByBranch[b.id] ?? []).map((a) => (
                <li key={a.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {a.nameEn} — fee {Number(a.deliveryFee)} · min {Number(a.minOrderAmount)} {a.etaMinutes ? `· ${a.etaMinutes}m` : ""}
                  <form action={deleteAreaAction.bind(null, a.id)}><button style={{ color: "#b91c1c", border: 0, background: "none" }}>delete</button></form>
                </li>
              ))}
            </ul>
            <form action={addAreaAction.bind(null, b.id)} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              <input name="nameEn" placeholder="Area (EN)" required />
              <input name="nameAr" placeholder="Area (AR)" dir="rtl" required />
              <input name="deliveryFee" type="number" step="0.01" placeholder="Fee" style={{ width: 80 }} />
              <input name="minOrderAmount" type="number" step="0.01" placeholder="Min" style={{ width: 80 }} />
              <input name="etaMinutes" type="number" placeholder="ETA min" style={{ width: 80 }} />
              <button>+ Add area</button>
            </form>
          </section>
        );
      })}
    </main>
  );
}
