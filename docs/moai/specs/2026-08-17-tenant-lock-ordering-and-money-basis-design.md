# Tenant Lock Ordering & Purchasing Money Basis — Design

**Date:** 2026-08-17 · **Status:** implemented on `feat/suppliers-purchasing` (PR #133)
· **Scope:** two decisions that came out of the Spec 9 review cycle. The first is
codebase-wide and binding on every domain. The second is purchasing-only.

---

## Why now

Spec 9 (Suppliers & Purchasing) went through four review rounds. Two of them
shipped a deadlock. Both were invisible to a green 1000-test suite, and the
second was introduced *by the fix for the first* — the same mistake, made in the
opposite direction.

That is the signature of an undocumented invariant. The rule existed; it just
lived nowhere except in the shape of code nobody had reason to read. This
document writes it down.

---

## Part 1 — The tenant advisory key (codebase-wide)

### The mechanism, from the bottom up

**`withTenant`** (`src/db/with-tenant.ts`) opens a transaction and sets
`app.tenant_id` as a transaction-local setting. Every table has `ENABLE` +
`FORCE ROW LEVEL SECURITY` with a policy predicating on that setting, so RLS
scopes every query inside the callback to one tenant and fails closed outside
it. RLS is about *visibility*. It has nothing to say about lock ordering.

**`recordAuditEvent`** (`src/server/audit/service.ts:53`) is the piece that
matters here. The audit trail is a hash chain: each event stores a `seq` and a
fingerprint over the previous one, so two concurrent writers in the same tenant
must not compute the same `seq`. It serialises them on a per-tenant advisory
lock:

```sql
SELECT pg_advisory_xact_lock(hashtext(<tenantId>)::bigint)
```

`pg_advisory_xact_lock` is held until the transaction commits — it cannot be
released early — and it is **re-entrant** within a transaction, so a nested
re-acquisition is a no-op.

The consequence is the whole point: **almost every mutating transaction in this
codebase takes this one key, and takes it at the very end**, because
`recordAuditEvent` is the last thing a writer does. That is true in ordering,
inventory, POS, notifications, catalog and purchasing alike.

### The rule

> **Never hold `hashtext(tenantId)` while waiting for a row lock.**
>
> Equivalently: **rows first, tenant key last.**

Because the key is taken last by default, the codebase already has a single
global lock order. Two transactions that both obey it can *block* on each other
— one waits for the other's row, or for the key — but they cannot form a cycle,
so Postgres never has to kill one with `40P01`.

Break it in one place and that place deadlocks against every writer that still
obeys it, which is most of the application.

### Incident 1 — key before row (found in review round 3)

`checkReorder` acquired the key as its first statement and then `UPDATE`d an
open draft purchase order. Every other PO writer took `SELECT ... FOR UPDATE`
on that draft and reached the key only via its closing audit event:

```
T1  sendPurchaseOrder   [row: PO X] ─────────► wants key
T2  checkReorder        [key]       ─────────► wants row: PO X
```

Measured: **12/12 rounds deadlocked** for `updateDraftPo` and
`cancelPurchaseOrder`, 11/12 for `sendPurchaseOrder`.

### Incident 2 — the fix that generalised the bug (found in review round 4)

The fix introduced a `lockTenant` helper and made the key the first statement of
every **purchasing** writer. That reasoning was wrong in a specific and
instructive way: it treated "consistent within purchasing" as "consistent",
when the key is global. Making purchasing take it first did not remove the
inversion — it *moved* it, from purchasing-vs-purchasing to
purchasing-vs-everything-else.

`postReceipt` → `receiveStock` → `syncLinkedSellable` → `mirrorLegacyStock`
updates `products.stock_quantity`. `adjustStock` updates that same row and then
audits:

```
T1  postReceipt   [key]              ─────────► wants row: products P
T2  adjustStock   [row: products P]  ─────────► wants key
```

Measured: **11/12 rounds deadlocked**, on "receive a delivery while someone
adjusts stock" — a more routine collision than the one being fixed, surfacing as
an opaque 500 at the goods-in door.

### What was implemented

Purchasing does **not** pre-acquire the key. Writers that must serialise against
a concurrent writer take `SELECT ... FOR UPDATE` on the row they are about to
change — narrower than a tenant-wide lock, and consistent with every other
domain. `checkReorder`'s merge path takes `FOR UPDATE` on the draft it merges
into.

### The one exception: `lockPoNumbering`

`src/server/purchasing/locking.ts` exports exactly one helper, used in exactly
two places (`createDraftPo` and `checkReorder`'s new-draft branch):

```ts
export async function lockPoNumbering(tx: Tx, tenantId: string): Promise<void>
```

It protects the `MAX(po_number) + 1` read-then-insert window, exactly as
`placeOrder` does for order numbers, backstopped by
`UNIQUE (tenant_id, po_number)` so a missed lock is a failed insert rather than
a duplicate.

**Why it is safe despite the rule:** everything it covers is an `INSERT` of a
brand-new row. It never waits on a row another transaction could be holding, so
it can never be the blocked half of a cycle. It is also taken as late as
possible — after the validation `SELECT`s, immediately before the `MAX` read.

The distinction is not "advisory locks are fine sometimes". It is: *holding the
key is safe only while you cannot block on a row.*

### Alternatives considered

| Option | Verdict |
|---|---|
| Key first in every writer, codebase-wide | The only other coherent total order, but it means touching every domain, holding a tenant-wide lock for the duration of every write, and serialising all tenant activity behind the slowest transaction. Rejected as disproportionate. |
| A purchasing-specific key (`hashtext(tenantId \|\| ':purchasing')`) | Removes the ordering against the audit key, but adds a second key that any future writer must also reason about, and still needs its own numbering lock. More moving parts for no gain over "take rows first". |
| `SERIALIZABLE` isolation | Converts deadlocks into serialisation failures, which still need retry handling, and would change behaviour repo-wide. Out of scope. |
| Retry on `40P01` | Treats the symptom. A cycle that fires on a routine path is a design error, not a transient. |

### When you add a new tenant writer

1. Take row locks (`FOR UPDATE`) on anything you will `UPDATE` or `DELETE`.
2. Do your reads and writes.
3. Call `recordAuditEvent` last. It takes the key for you.
4. Do **not** call `pg_advisory_xact_lock(hashtext(tenantId))` yourself unless
   everything after it is an insert of a new row — and if it is, prefer
   `lockPoNumbering`'s shape and document why.

### How this is verified

`src/server/purchasing/locking.test.ts` races real exported functions and
asserts zero `40P01` across both directions of the rule:

| Pairing | pre-round-3 | round-4 (`64830cd`) | now |
|---|---|---|---|
| `checkReorder` ‖ `updateDraftPo` | 12/12 | 0 | **0** |
| `checkReorder` ‖ `sendPurchaseOrder` | 12/12 | 0 | **0** |
| `checkReorder` ‖ `cancelPurchaseOrder` | 12/12 | 0 | **0** |
| `postReceipt` ‖ `adjustStock` | 0 | 11/12 | **0** |
| `checkReorder` ‖ `upsertReorderRule` | 0 | 0 | **0** |
| `checkReorder` ‖ `checkReorder` | 0 | 0 | **0** |
| `createDraftPo` ×3 (numbering) | 0 | 0 | **0** |
| `createDraftPo` ‖ `updateSupplier` (FK) | 0 | 0 | **0** |

The columns matter as much as the last one: a probe that has never reproduced
the bug is not evidence that the bug is gone. This one was run against both
broken commits and reproduces each of them.

It also pins the two non-deadlock properties the locks buy: a merge racing
`updateDraftPo` leaves the header consistent with its lines, and concurrent
drafting keeps `po_number` unique with no rejected inserts.

---

## Part 2 — One money basis for purchasing (purchasing-only)

### The problem

Three figures describe the same purchase order:

| Figure | Source |
|---|---|
| **ordered** | `purchase_orders.total` |
| **received** | `Σ po_receipt_lines.received_qty × unit_cost` |
| **invoiced** | `purchase_orders.invoice_total` |

`getPoVariance` reports `receivedVsOrdered` and `invoiceVsReceived` from them,
and that three-way match is the entire point of the feature: it is how a buyer
notices a supplier billed for goods that never arrived.

`invoice_total` is what the supplier actually bills, which is **gross**
(tax-inclusive). The other two were **net**. So every tax-bearing PO carried a
permanent structural variance, and real discrepancies drowned in it.

An earlier attempt to fix this made `purchase_orders.total` gross and stopped
there. That was worse than doing nothing: `po.total` feeds only
`receivedVsOrdered`, so the change left `invoiceVsReceived` exactly as wrong as
before while **breaking a delta that had been correct** — a flawless
10 × 5.00 @ 14% PO went from `receivedVsOrdered = 0.00` to `-7.00`.

### Decision

**All three figures are gross.** `invoice_total` is gross by nature and cannot
be changed, so the other two are grossed up to meet it.

- `purchase_orders.total` = `Σ qty × unitCost × (1 + taxRate)`, in `lineTotal()`
  — the single place a PO total is computed.
- `received` grosses up with the *ordering* line's rate, joining
  `po_receipt_lines → purchase_order_lines`. Receipt lines carry no rate of
  their own, and adding one would duplicate a fact that already exists.
- `getPoVariance` and `getReceivedVsInvoiced` use the identical expression, so
  the detail view and the report cannot disagree.

Result on a correct tax-bearing PO: `receivedVsOrdered = 0.00`,
`invoiceVsReceived = 0.00`.

### Consequences

- **`taxRate` is a rate, not currency.** It is stored via `String()`, not
  `money()`. `money()` is a 2-decimal *currency* formatter and was silently
  turning 12.5% into 13%.
- **The emailed PO shows a subtotal/tax/total block.** Line rows stay net so the
  column sums to the subtotal; tax is broken out once in the footer. Without it
  a gross header sat above net rows and the document did not add up — visible to
  the supplier receiving it.
- **Rejected alternative:** carrying `tax_rate` onto `po_receipt_lines`. It
  needs a migration and lets the two copies drift; the join is exact and free.

---

## Deliberate deferrals

Stated here and in `postReceipt`'s docstring so they read as decisions rather
than oversights:

- **Receipts are not idempotent.** A retried POST writes a second receipt; the
  PO-row lock serialises rather than collapses it. Fixing it needs a
  client-supplied receipt key plus `UNIQUE (tenant_id, purchase_order_id, key)`
  — an API-contract change.
- **Over-receipt has no tolerance.** Suppliers over-ship routinely and refusing
  goods at the door is worse than recording them; the excess surfaces in
  `getPoVariance().overReceived`. A percentage tolerance with an override flag
  is the follow-up.

## Operational note

The purchase-factor guard added in this cycle rejects items where
`purchase_uom = base_uom` and `purchase_to_base <> 1` for mass/volume — a
contradictory configuration that silently over-credited the ledger by that
factor. It is legitimate for `count`, which is how a 24-can case is expressed.

Existing data was never validated against this. **Before deploying, run:**

```sql
SELECT tenant_id, id, name_en, base_uom, purchase_uom, purchase_to_base
FROM inventory_items
WHERE purchase_uom = base_uom AND purchase_to_base <> 1 AND base_uom <> 'each';
```

Any row returned cannot receive against an open PO until it is normalised.
