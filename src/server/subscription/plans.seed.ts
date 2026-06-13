import { db } from "@/db/client";
import { plans, type PlanLimits, type PlanFeatures } from "./schema";

type Seed = { key: string; name: string; priceMonthly: string; limits: PlanLimits; features: PlanFeatures };

export const DEFAULT_PLANS: Seed[] = [
  {
    key: "basic",
    name: "Basic",
    priceMonthly: "0",
    limits: { branches: 1, staff: 2, products: 50, whatsapp_numbers: 0, orders_per_month: 200, messages_per_month: 0 },
    features: { whatsapp: false, custom_domain: false, custom_theme: false, reservations: false, advanced_analytics: false },
  },
  {
    key: "pro",
    name: "Pro",
    priceMonthly: "499",
    limits: { branches: 3, staff: 10, products: 500, whatsapp_numbers: 1, orders_per_month: 2000, messages_per_month: 5000 },
    features: { whatsapp: true, custom_domain: false, custom_theme: true, reservations: true, advanced_analytics: false },
  },
  {
    key: "enterprise",
    name: "Enterprise",
    priceMonthly: "1499",
    limits: { branches: 50, staff: 200, products: 100000, whatsapp_numbers: 10, orders_per_month: 100000, messages_per_month: 100000 },
    features: { whatsapp: true, custom_domain: true, custom_theme: true, reservations: true, advanced_analytics: true },
  },
];

export async function seedDefaultPlans(): Promise<void> {
  for (const p of DEFAULT_PLANS) {
    await db
      .insert(plans)
      .values({ key: p.key, name: p.name, priceMonthly: p.priceMonthly, currency: "EGP", limits: p.limits, features: p.features })
      .onConflictDoUpdate({
        target: plans.key,
        set: { name: p.name, priceMonthly: p.priceMonthly, limits: p.limits, features: p.features },
      });
  }
}
