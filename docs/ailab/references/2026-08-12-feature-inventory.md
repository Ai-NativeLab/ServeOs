# ServeOS Feature Inventory — what exists, and what can be sold

**Date:** 2026-08-12
**Purpose:** input for carving the four pricing tiers (Free / 499 / 699 / 1099 EGP)

Compiled by auditing `src/server/`, the tenant-facing routes under `src/app/dashboard/`, and every
call site of the entitlements layer. Three things matter here and they are not the same:
**built**, **reachable by a tenant**, and **enforced as a plan boundary**.

---

## 1. The gating vocabulary that exists today

`plans.features` and `plans.limits` (`src/server/subscription/schema.ts`) define twelve knobs.
Only **seven are wired to anything**.

### Feature flags

| Flag | Enforced? | Where |
|---|---|---|
| `online_ordering` | ✅ | `ordering/service.ts:105`, `app/page.tsx:62` |
| `whatsapp` | ✅ | `whatsapp/ingest.ts:51` |
| `advanced_analytics` | ✅ | `dashboard/analytics/reports-permission.ts:20` |
| `custom_domain` | ❌ **not enforced anywhere** | — |
| `custom_theme` | ❌ **not enforced anywhere** | — |
| `reservations` | ❌ not enforced — **and the domain does not exist** | — |

### Limits

| Limit | Enforced? | Where |
|---|---|---|
| `products` | ✅ | `catalog/service.ts:145` |
| `branches` | ✅ | `branches/service.ts:37` |
| `whatsapp_numbers` | ✅ | `whatsapp/linking.ts:23` |
| `orders_per_month` | ⚠️ counted, **never blocks** | `ordering/service.ts:416` increments; the comment at :415 says `checkUsage` is deliberately not enforced at placement |
| `messages_per_month` | ❌ counted nowhere | — |
| `staff` | ❌ **not enforced** | — |

> **The most important line on this page.** Daftra's matrix — the one you liked — publishes numeric
> limits. If we publish `staff: 10` or `orders: 2,000/month`, we state a boundary the code does not
> apply: a tenant on Free can add 500 staff today. Either wire the check or don't print the number.

---

## 2. Built, reachable, and completely ungated

These are the real candidates for new plan lines. Every one has a tenant-facing surface.

### Selling surfaces
| Capability | Domain | Tenant surface |
|---|---|---|
| Online storefront | `catalog`, `ordering` | `<slug>.serveos.tech` |
| QR / table ordering | `ordering` | storefront |
| WhatsApp ordering | `whatsapp` | `/settings/whatsapp`, `api/whatsapp/webhook` |
| Point of sale | `pos` | `api/pos/v1`, `/settings/pos-devices`, separate Vite/Electron app |
| Multi-branch | `branches` | `/branches` |
| Four trade templates | `verticals` | per-vertical storefront template |

### Catalog
| Capability | Domain | Tenant surface |
|---|---|---|
| Products, categories, images | `catalog` | `/menu` |
| Bilingual product names | `catalog` | `/menu/products/[id]` |
| Variants (size / colour / pack) | `catalog` | `VariantsEditor` |
| Dimensional pricing (m³, linear m, sheet) | `catalog/dimensional-pricing`, `inventory/uom` | storefront product sheet |
| Modifiers | `catalog` | `/menu` |
| Banners / promotions | `banners` | `/banners` |

### Operations
| Capability | Domain | Tenant surface |
|---|---|---|
| Orders + lifecycle | `ordering` | `/orders`, `/orders/[id]` |
| Order history | `ordering` | `/orders/history` |
| Inventory items + stock ledger | `inventory` | `/inventory` |
| Lots, batch codes, expiry | `inventory` | `/inventory` movement forms |
| Recipes / BOM auto-deduction | `inventory/recipes` | `/inventory/recipes` |
| Purchasing | `inventory` | `/analytics/purchasing` |
| Prescriptions (Rx review, dispensing) | `prescriptions` | `/prescriptions` |
| Fulfilment + delivery areas | `branches` | `/settings/fulfillment` |
| Taxes | `tenancy` | `/settings/taxes` |
| Payment methods + reconciliation | `payments` | `/payments`, `/settings/payment-methods` |

### Insight and control
| Capability | Domain | Tenant surface |
|---|---|---|
| Sales analytics | `analytics` | `/analytics/sales` |
| Financial analytics | `analytics` | `/analytics/financial` |
| Inventory analytics | `analytics` | `/analytics/inventory` |
| Purchasing analytics | `analytics` | `/analytics/purchasing` |
| Customers / CRM | `customers` | `/customers` |
| Staff + roles (RBAC) | `rbac`, `auth` | `/settings/staff` |
| Audit log | `audit` | `/audit` |
| Notifications + email | `notifications`, `email` | `/notifications` |

---

## 3. Not built — must not be sold

These carry the قريبًا chip on the marketing page and keep it.

| Feature | Status |
|---|---|
| Table reservations | **No domain at all.** `plans.features.reservations` is a flag pointing at nothing |
| Barcode checkout | Nothing in server or UI |
| Generic substitutes (pharmacy) | Nothing |
| Cut-to-order lists (timber) | `inventory/service.ts:706` has `deductCutToSize`, but **no UI surfaces a cutting list** — a yard cannot use it |

---

## 4. Suggested plan dimensions

Grouped the way Daftra groups them, using only what is built. ✏️ marks a gate that needs writing.

**Selling channels** — storefront · QR ordering · WhatsApp ✅ · POS ✏️ · multi-branch ✅

**Catalog** — products ✅ · variants ✏️ · dimensional pricing ✏️ · banners ✏️

**Operations** — orders · inventory ✏️ · recipes/BOM ✏️ · prescriptions ✏️ · purchasing ✏️ · payments ✏️

**Insight** — basic analytics · advanced analytics ✅ · audit log ✏️ · customers/CRM ✏️

**Scale** — branches ✅ · staff ✏️ · products ✅ · WhatsApp numbers ✅ · orders/month ⚠️ counted only

**Brand** — custom theme ✏️ · custom domain ✏️

### The natural high-value gates

Judged on what a shop owner would pay to unlock, and what is cheap to wire because the domain is
already isolated:

1. **Inventory + recipes** — the largest capability with no gate at all. A koshary chain paying for
   BOM deduction is an easy upsell; a single kiosk does not need it.
2. **POS** — free to anyone today. It is a separate application and the obvious paid line.
3. **Prescriptions** — pharmacy-only, high value, entirely ungated.
4. **Advanced analytics** — already gated and enforced. Working as intended.
5. **Staff seats** — the most conventional SaaS lever, and the limit column already exists; it only
   needs the `checkQuota` call adding.

---

## 5. Before publishing a matrix

1. **Wire or drop the six unenforced knobs.** Publishing an unenforced number is a claim we do not
   keep — the same class of problem as the roadmap chips and the Arabic-interface FAQ answer.
2. **Decide `reservations`.** A flag with no feature behind it can be sold by accident. Build it or
   remove it.
3. **`orders_per_month` is counted but never blocks**, deliberately — a quota must never stop a
   kitchen mid-service. That is a good decision, so present it as "included", not as a cap.
