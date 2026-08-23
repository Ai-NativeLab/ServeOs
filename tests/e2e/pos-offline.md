# POS offline sync — manual run: pull the network mid-shift

A scripted run of the Electron till through a real outage: pair, sign in online
(so the till has something to check offline credentials against), open a
drawer, lose the network, sell twice, pay out cash, close the shift blind,
reconnect, and watch the queue drain. Run this before shipping any change that
touches `apps/pos/electron/_offline/*`, `pos-main.ts`, or the sync ingestion
endpoint — machines have already proven the two hardest parts (the server's
replay and the till's SyncEngine); this proves the parts only a human eye can
check: what the operator actually sees on screen.

Budget ~20 minutes. Screenshot every step marked **📸** and file them with
whatever ticket/PR this run is verifying.

## What machines already proved — do not re-derive this

Two automated suites cover the mechanics end to end. If this run turns up a
correctness bug, it is almost certainly in the UI/IPC glue between them (or a
genuine gap in both) — check there first before assuming the core logic is
wrong.

**`src/server/pos/offline-lifecycle.test.ts`** (server, real Postgres) — the
authoritative proof that a full offline shift replays correctly:
- The exact 8-event batch a till produces for a whole outage (`session.signed_in`
  → `shift.opened` → 2× `sale.recorded`, one with a line discount authorized
  via offline `grant.issued` → `cash.movement` pay-out → `count.recorded` →
  `shift.closed`) lands with the till's *claimed* timestamps, not the ingest
  time — shift open/close, order `placedAt`, the business day they fall on.
- Per-actor attribution (two different cashiers on one shift), the offline
  manager authorizer on both the discount and the pay-out.
- Inventory deducts correctly, or goes negative with a low-stock notification
  when the offline batch oversells.
- The Z-report figures match the event math exactly; the audit hash chain
  verifies; replaying the whole batch again changes nothing (byte-identical
  duplicate results).
- Adversarial variants: a product unpublished mid-outage (till-wins off the
  line snapshot + a `pos.replay.price_drift` audit event), a replay landing
  outside the branch's current opening hours (still ingests — till-wins),
  concurrent duplicate ingestion of the same batch (no double-apply), and a
  malformed 2nd event (halts there, events 3+ untouched, a corrected retry
  resumes at the same seq).

**`apps/pos/electron/_offline/sync.test.ts`** (till-side `SyncEngine`, no
Electron runtime needed) — the authoritative proof of the queue's own
behavior: strict seq ordering and resuming mid-batch after a cut, the wire
envelope shape, the **sticky halt** (one refused event blocks everything
behind it, and stays blocked across ticks until `retryFailed`), halted-on-
restart with no re-send, single-flight coalescing, duplicate-safe replay
after reconnect, `onApplied` firing in seq order, a batch-level (not
per-event) refusal neither halting nor losing the queue, and the
offline→online ping transition pulling catalog+roster and draining the flush.

**`apps/pos/electron/_offline/store.test.ts`** and **`sync-receipt.test.ts`**
(Task 14) additionally cover: 30-day retention only ever deletes `synced`
rows; `auth_cache.password_hash`/`catalog_cache.json` encrypt at rest and a
pre-encryption plaintext row still reads; `markEventSynced` and the till-state
snapshot write now commit as one transaction; and the audit page's
clock-skew-flagged receipts read is tenant-scoped correctly.

**None of that renders anything.** This script is for the SyncBadge states,
the disabled-surface notices, the receipt's pending-sync line, and the
sticky-halt modal — the pixels no test asserts on.

## Setup

```
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"   # Node 22
```

**Terminal A — the backend the till talks to:**
```
npm run pos:demo:web
```
Starts the Next.js app against the `.env.test` database at
`http://localhost:3000`. Leave it running until step 10.

**A tenant to sign in with**, on that same `.env.test` database, with:
- at least one active staff/owner account with a **known password**, and
- at least one **published** product, on a branch that is **accepting orders**.

If you don't already have one: sign up at `http://localhost:3000/register`
like any new restaurant would (creates the tenant, owner account with a
password, and a first branch), then Dashboard → Menu → publish 1–2 products,
and confirm Dashboard → Settings → Branches shows the branch accepting orders.

> **Known gap, not this task's to fix:** `npm run pos:demo:code`
> (`scripts/pos-demo-seed.ts`) seeds a `posdemo` tenant/branch/menu and prints
> a *pairing code* for `POST /api/pos/v1/pair` — but the till's actual sign-in
> screen (`LoginScreen.tsx`, step 1 below) only has restaurant-slug + email +
> password fields and calls `POST /api/pos/v1/login`. `window.pos.pair` is
> wired over IPC but nothing in `apps/pos/src` calls it, and the seed
> script's "Demo Owner" has no password to use with `login` either. Don't
> spend time hunting for a code field — use the slug/email/password account
> above.

**Terminal B — the till:**
```
npm run pos:dev
```
Opens the real Electron window, pointed at `http://localhost:3000` by
default in dev.

> **Loopback callout, read before step 4:** the till's `SyncEngine` runs its
> `fetch` calls in the Electron **main** process, not the renderer — and
> against `localhost:3000`, loopback traffic never touches the Wi-Fi
> adapter. **Turning off Wi-Fi does nothing in this setup.** "Kill the
> network" below means **stop the `pos:demo:web` process** (Ctrl+C in
> Terminal A). If you instead want a true network-level test, point the till
> at a real deployed host first — `POS_API_URL=https://<your-qa-host>
> npm run pos:dev` — and Wi-Fi-off becomes the real test.

## The run

### 1 — Pair the device

Launch (`npm run pos:dev`). On **"Sign in to ServeOS POS"**, enter the
tenant's slug, the account's email, and its password. Submit.

- If the tenant has more than one active branch, a branch picker appears —
  pick one.
- **Expected:** the device is now paired (`pos-device.json` written,
  encrypted via `safeStorage` when the OS supports it); you land on
  **Cashier sign-in**.

📸 Cashier sign-in screen, with the branch name in its subtitle.

### 2 — Sign in the cashier **online** — this seeds the offline roster

On Cashier sign-in, enter an active staff account's email + password (the
same account is fine) **while Terminal A is still running**. Submit.

This is the load-bearing step: `signInCashier` tries the live
`/api/pos/v1/cashier/login` first. On success it immediately pulls the auth
roster (`auth_cache`) so the till has something to check a password against
later. **Offline sign-in is impossible before this has happened at least
once** — `findAuthUser` finds nothing in an empty cache. If you skip straight
to killing the network before this step, step 4 onward cannot work at all
(no cashier can sign in, offline or not).

- **Expected:** header badge reads **Online**. You land on **Open the
  drawer** (or **Take order**, if a drawer is already open on this till).

📸 Header badge showing "Online".

### 3 — Open the drawer

Enter an opening float (e.g. `200`), optionally "Count it note by note",
submit.

- **Expected:** lands on the tabbed shell; the "No drawer" tag by the badge
  is gone; Drawer tab shows opening float `200.00` and expected cash
  `200.00`.

📸 Drawer tab right after opening.

### 4 — Kill the network

Stop `pos:demo:web` (Ctrl+C in Terminal A) — see the loopback callout above.

- **Expected:** within one ping interval (~15s) the badge flips
  **Online → Offline**. Nothing else changes — offline is not blocking, and
  no modal appears.

📸 Header badge showing "Offline".

### 5 — Sell #1, offline

Take order → add a line (e.g. 1× your first published product) → Pay → a
cash tender covering the total → complete.

- **Expected:** the sale completes immediately — no spinner waiting on a
  network round trip, since `recordSale` answers from local state once the
  engine reports itself offline. The receipt shows:
  - an order number in the form **`T-XXXXXX`** (`shortCode(clientOrderId)`:
    the last 6 hex characters of the sale's client id, uppercased) — not a
    normal-looking numeric order number,
  - the line **"Pending sync — order number is provisional"** directly under
    the date/order-number row.
- Badge stays **Offline** — nothing to flush yet while there's no network.

📸 The receipt: `T-XXXXXX` code and the pending-sync line both visible.

### 6 — Sell #2, offline

Repeat step 5 with a different item and tender (e.g. card, no change line).
Same expectations — a different `T-XXXXXX` code, same pending-sync line.

📸 Second receipt.

### 7 — A pay-out, offline

Drawer tab → **Pay out** → an amount → a reason → submit.

- With a tenant that has no configured `payoutThreshold` (the default —
  `payoutThreshold: 0` means *no threshold*, not *zero tolerance*: see
  `payoutNeedsManager` in `till.ts`), this applies immediately with **no**
  manager prompt, for any amount.
- **If** your tenant does have a threshold configured and you exceed it,
  expect **"Manager approval needed"** (`ManagerAuthModal`) instead — enter a
  manager account's email + password. This is the *offline* authorization
  path (`offline-auth.ts`'s `offlineGrant`), checked against the same cached
  roster step 2 seeded — worth triggering at least once in some run, since it
  is the whole reason step 2 has to happen online first.
- **Expected:** Drawer tab's movements list shows the pay-out. The badge
  stays **Offline** (there is still no network to flush to) — it does *not*
  show a pending count; only the `syncing`/`halted` states surface a number.

📸 Drawer tab with the pay-out recorded.

### 8 — Close the shift, offline

Drawer tab → **Close drawer** → enter the counted total → submit.

- If you are not the cashier who opened the drawer and don't hold
  `reconciliation:manage`, expect the same offline manager-authorization
  prompt as step 7 first.
- **Expected:** the **"Drawer closed"** Z-report appears immediately — built
  from the till's own local event log (`tillReport("z", …)`), no network
  involved. Shows counted/expected/variance (unless the tenant blind-closes,
  in which case expected/variance are withheld and a note says so), sales
  count, tenders, and movements.

📸 The "Drawer closed" report modal.

### 9 — What the rest of the app shows while offline

Before restoring the network, check the two server-backed tabs:

| Tab | Expected offline notice |
|---|---|
| **Live orders** | "Web orders are unavailable offline" — "This queue reads live from the server — it will catch up once the till reconnects." |
| **History** | "History, refunds and reprints are unavailable offline" — "These read and write the server's own sale records — they will work again once the till reconnects." |

📸 Both notices.

### 10 — Restore the network

Restart `pos:demo:web` in Terminal A; give it a few seconds to come back up.

- **Expected** within one ping interval: badge cycles
  **Offline → Syncing (N queued) → Online**, N counting down as the queue
  flushes in batches (you'll have 4–6 events queued from this run — one
  round trip). No action needed; the engine's own timer drives this.

📸 The badge mid-drain ("Syncing (N queued)") if you catch it, and the final
"Online".

### 11 — Confirm the queue actually drained

- **Live orders** and **History** load normally again.
- Open **History**, find the two sales from steps 5–6 (by amount/date, or
  the real order number if you noted it) — `orderNumber` is now the server's
  real number, no longer the `T-XXXXXX` code. Reprint one: the receipt no
  longer says "pending sync".

📸 History detail view for one of the two sales, `paymentStatus: paid`.

### 12 — (Optional) Dashboard cross-check

In a browser, sign in to the dashboard for this tenant and open
`/dashboard/audit`:

- The chain banner reads "Chain OK".
- If a *different* run replayed a sale for a product unpublished mid-outage,
  filter the "action" box to `pos.replay.price_drift` — it's there (this
  already worked before Task 14; nothing new was built for it, only
  verified).
- The amber "clock-skew-flagged sync events" banner (added in Task 14) only
  appears when an event's `occurredAt` was >48h from the server's clock at
  ingest time — not expected in a same-day run like this one, since nothing
  above ever claims a backdated time.

📸 Audit page banner(s).

## If it halts instead

Not expected in a clean run, but if the server refuses one of your events
(e.g. a stale `catalogVersion`, a permission the roster cache disagrees with
the server about), a full-screen **"Sync halted"** modal blocks every screen
past sign-in — by design (Task 10's sticky halt: everything queued behind
the refused event is on hold until it's resolved). It shows the failing
event's type + the server's error, a **Retry** button (`retryFailed()`), and
a **Contact support** mailto. This is expected UI, not a bug — but if you see
it during this script, the underlying refusal *is* worth investigating.
