# QA — Personas and the permission matrix

Who the cases are written for, which account each one uses, and exactly what
each role may do. Every `permission` case in the pack resolves against the
matrix at the bottom of this file.

**Last verified against code:** 2026-08-17 · `src/server/rbac/permissions.ts`

---

## The nine personas

Pronouns: they/them throughout — the pack never assumes a tester's or a
persona's gender.

| # | Persona | Role key | Surfaces | Account |
|---|---------|----------|----------|---------|
| 1 | **Prospect** — evaluating ServeOS, never signed in | *none* | `MKT` | no account |
| 2 | **Guest customer** — orders without registering | *none* | `SF` | no account |
| 3 | **Account customer** — registers at one shop, sees their orders | *none* (customer lane) | `SF` | created in `SF-ACCT` |
| 4 | **WhatsApp customer** — orders in chat | *none* (waId) | `WA` | a phone number |
| 5 | **Cashier** — works the till and the order queue | `staff` | `POS`, `DSH` (limited) | `staff@roma.com` / `staff1234` |
| 6 | **Manager** — runs the shop day to day | `manager` | `DSH`, `POS` | `manager@roma.com` / `manager1234` |
| 7 | **Owner** — owns the business, holds the money | `owner` | `DSH`, `POS` | `owner@roma.com` / `owner1234` |
| 8 | **Pharmacist** — licensed reviewer of prescriptions | `pharmacist` | `DSH` (Rx), `POS` | **must be created by hand** — see below |
| 9 | **Platform admin** — ServeOS staff | `super_admin` | `ADM` | `admin@serveos.com` / `admin1234` |

Personas 2, 3 and 4 hold no role at all. Customers are not users: they live in
their own table, in their own session lane, with their own cookie
(`serveos_customer`) — a customer cookie can never open the dashboard.

### Seeded tenants

| Command | Tenant | Slug | Vertical | Owner |
|---------|--------|------|----------|-------|
| `npm run db:seed` | Pizza Roma | `roma` | restaurant | `owner@roma.com` / `owner1234` |
| `npm run demo:seed` | Zeytoun Kitchen | `demo-restaurant` | restaurant | `owner@demo-restaurant.serveos.com` / `demo1234` |
| `npm run demo:seed` | Baraka Mini Market | `demo-retail` | retail | `owner@demo-retail.serveos.com` / `demo1234` |
| `npm run demo:seed` | El Salam Pharmacy | `demo-pharmacy` | pharmacy | `owner@demo-pharmacy.serveos.com` / `demo1234` |
| `npm run demo:seed` | Nile Timber Yard | `demo-timber` | timber | `owner@demo-timber.serveos.com` / `demo1234` |

`roma` carries the three-role user set (owner, manager, staff); the four demo
tenants carry **only an owner** each, plus a seeded catalogue and order history.
`npm run demo:seed --reset` drops and rebuilds them, which is the only reliable
way to undo a visitor's edits.

All of the above are **local seed credentials**. Production rotation is covered
in `docs/NEW-LAPTOP-SETUP.md` Part 3b.

### The pharmacist has to be made by hand

No script seeds a `pharmacist`. Before running any `rx:review` case:

1. Sign in to `demo-pharmacy` as its owner.
2. Settings → Staff → invite a user, assign the **pharmacist** role.
3. Use that account for `SF-RX` and `DSH-RX`.

This is itself covered by `DSH-STAFF`, so running that journey first gets the
account as a side effect.

### Local hosts

Subdomain routing needs `/etc/hosts` entries. Add every slug the pack touches:

```
127.0.0.1 serveos.localhost www.serveos.localhost app.serveos.localhost admin.serveos.localhost
127.0.0.1 roma.serveos.localhost
127.0.0.1 demo-restaurant.serveos.localhost demo-retail.serveos.localhost
127.0.0.1 demo-pharmacy.serveos.localhost demo-timber.serveos.localhost
```

On QA the same layout exists under `qa.serveos.tech` with no hosts file needed
(`*.qa.serveos.tech` is a real wildcard domain).

---

## The permission matrix

25 permissions over 5 roles: 22 tenant-scoped and 3 platform-scoped. Source of
truth is `ROLE_PERMISSIONS` in `src/server/rbac/permissions.ts:32`.

| Permission | owner | manager | staff | pharmacist | super_admin |
|---|:---:|:---:|:---:|:---:|:---:|
| `tenant:manage` | ✅ | — | — | — | — |
| `staff:invite` | ✅ | ✅ | — | — | — |
| `plan:view` | ✅ | ✅ | ✅ | ✅ | — |
| `plan:change` | ✅ | — | — | — | — |
| `billing:manage` | ✅ | — | — | — | — |
| `menu:manage` | ✅ | ✅ | — | — | — |
| `orders:manage` | ✅ | ✅ | ✅ | ✅ | — |
| `fulfillment:manage` | ✅ | ✅ | — | ✅ | — |
| `payments:confirm` | ✅ | ✅ | — | — | — |
| `pos:sell` | ✅ | ✅ | ✅ | ✅ | — |
| `pos:discount` | ✅ | ✅ | — | — | — |
| `pos:void` | ✅ | ✅ | — | — | — |
| `pos:refund` | ✅ | ✅ | — | — | — |
| `audit:view` | ✅ | ✅ | — | — | — |
| `reconciliation:manage` | ✅ | ✅ | — | — | — |
| `reports:view` | ✅ | ✅ | — | — | — |
| `reports:financial` | ✅ | ✅ | — | — | — |
| `customers:manage` | ✅ | ✅ | — | — | — |
| `rx:review` | ✅ | — | — | ✅ | — |
| `inventory:view` | ✅ | ✅ | ✅ | — | — |
| `inventory:manage` | ✅ | ✅ | — | — | — |
| `inventory:count` | ✅ | ✅ | ✅ | — | — |
| `platform:approve_tenant` | — | — | — | — | ✅ |
| `platform:suspend_tenant` | — | — | — | — | ✅ |
| `platform:view_revenue` | — | — | — | — | ✅ |
| **Total** | **22** | **18** | **5** | **5** | **3** |

### Four properties of this matrix worth testing directly

These are asserted in `99-cross-cutting.md` under `XC-RBAC`, and they are the
reason the matrix is stated here rather than left implicit.

1. **The platform and tenant lanes never overlap.** `super_admin` holds no
   tenant permission and `owner` holds no platform permission. Neither can be
   reached by escalation from the other.
2. **`rx:review` skips manager.** Owner and pharmacist only. A compliance trail
   has to name a licensed reviewer, so "a manager approved it" is not an
   acceptable record. A manager on a pharmacy tenant genuinely cannot review a
   prescription — that is the design, not a bug.
3. **Staff can count stock but not change it.** `inventory:view` +
   `inventory:count` without `inventory:manage`, so a staff member reaches the
   stock screen to count shelves and cannot edit items.
4. **Pharmacist holds `fulfillment:manage` but not `inventory:*`.** They work
   the shop floor and the Rx queue; they do not touch stock records.

### What the dashboard sidebar shows per role

Derived by `dashboardNavItems` (`src/components/dashboard/nav-items.ts`) from
the permissions above. Tested by `DSH-NAV` and `XC-RBAC`.

| Nav item | Gated on | owner | manager | staff | pharmacist |
|---|---|:---:|:---:|:---:|:---:|
| Home | `menu:manage` \|\| `fulfillment:manage` | ✅ | ✅ | — | ✅ |
| Analytics | `menu:manage` | ✅ | ✅ | — | — |
| Orders | `orders:manage` | ✅ | ✅ | ✅ | ✅ |
| Sales history | `orders:manage` | ✅ | ✅ | ✅ | ✅ |
| Payments | `payments:confirm` | ✅ | ✅ | — | — |
| Menu / Products / Yard | `menu:manage` | ✅ | ✅ | — | — |
| Inventory | `inventory:view` | ✅ | ✅ | ✅ | — |
| Branches | `menu:manage` | ✅ | ✅ | — | — |
| Banners | `menu:manage` | ✅ | ✅ | — | — |
| Settings | `fulfillment:manage` | ✅ | ✅ | — | ✅ |
| Audit | `audit:view` | ✅ | ✅ | — | — |
| Customers | `customers:manage` | ✅ | ✅ | — | — |
| Prescriptions | `rx:review` | ✅ | — | — | ✅ |
| **Items visible** | | **13** | **12** | **3** | **5** |

The catalogue item is **relabelled per vertical** — "Menu" on restaurant,
"Products" on retail and pharmacy, "Yard" on timber — from the vertical's
`catalogNoun`. Staff see only three items and land on Orders, not Home.

Two oddities in this table are real and worth a case each rather than a raised
eyebrow:

- **A pharmacist sees Settings.** `fulfillment:manage` gates it, and pharmacist
  holds that. They reach the settings hub without holding `tenant:manage`,
  `plan:change` or `billing:manage`, so what they can actually change inside it
  is narrower than the nav implies. `DSH-SET` covers where that boundary sits.
- **A pharmacist sees Home but not Analytics or Inventory.** Home is gated on
  either `menu:manage` or `fulfillment:manage`; Analytics on `menu:manage`
  alone.
