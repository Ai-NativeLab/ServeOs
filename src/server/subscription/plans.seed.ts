import { db } from "@/db/client";
import { plans, type PlanLimits, type PlanFeatures } from "./schema";

type Seed = { key: string; name: string; priceMonthly: string; limits: PlanLimits; features: PlanFeatures };

/**
 * Four tiers: 0 / 499 / 699 / 1099 EGP per month, billed on a three-month
 * minimum term.
 *
 * The EXISTING KEYS ARE KEPT. `seedDefaultPlans` upserts on `key`, and
 * `subscriptions.planId` points at these rows — renaming `basic` to `free`
 * would leave the old row orphaned with live subscriptions still attached to
 * it, and add a fifth plan the pricing page would then display. So `basic`,
 * `pro` and `enterprise` keep their keys and gain new display names, and only
 * `growth` is new.
 *
 * `reservations` is false on every tier on purpose: it is a flag with no domain
 * behind it, and leaving it true on a paid tier sells a feature that does not
 * exist.
 *
 * MIGRATION NOTE: `enterprise` drops from 1499 to 1099. Any tenant already on
 * it sees a price cut at their next renewal. That is a deliberate repricing,
 * not an accident of seeding — if some tenants must stay at 1499, they need
 * moving to a grandfathered plan row before this runs in production.
 */
export const DEFAULT_PLANS: Seed[] = [
  {
    key: "basic",
    name: "Free",
    priceMonthly: "0",
    limits: { branches: 1, staff: 2, products: 50, whatsapp_numbers: 0, orders_per_month: 200, messages_per_month: 0 },
    features: { whatsapp: false, custom_domain: false, custom_theme: false, reservations: false, advanced_analytics: false, online_ordering: true },
  },
  {
    key: "pro",
    name: "Starter",
    priceMonthly: "499",
    limits: { branches: 3, staff: 10, products: 500, whatsapp_numbers: 1, orders_per_month: 2000, messages_per_month: 5000 },
    features: { whatsapp: true, custom_domain: false, custom_theme: true, reservations: false, advanced_analytics: false, online_ordering: true },
  },
  {
    key: "growth",
    name: "Growth",
    priceMonthly: "699",
    limits: { branches: 5, staff: 25, products: 2000, whatsapp_numbers: 2, orders_per_month: 10000, messages_per_month: 20000 },
    features: { whatsapp: true, custom_domain: false, custom_theme: true, reservations: false, advanced_analytics: true, online_ordering: true },
  },
  {
    key: "enterprise",
    name: "Professional",
    priceMonthly: "1099",
    limits: { branches: 50, staff: 200, products: 100000, whatsapp_numbers: 10, orders_per_month: 100000, messages_per_month: 100000 },
    features: { whatsapp: true, custom_domain: true, custom_theme: true, reservations: false, advanced_analytics: true, online_ordering: true },
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
