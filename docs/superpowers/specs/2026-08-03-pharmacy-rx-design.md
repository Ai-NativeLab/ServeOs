# ServeOS — Pharmacy Rx Workflow (P3) Design

**Date:** 2026-08-03 · **Issue:** #56 · **Roadmap:** vertical-platform P3
**Owner decisions (2026-08-03):** upload + pharmacist review queue (not flag-only) · dedicated `pharmacist` role · **account required for Rx** (OTC stays guest-friendly) · per-line tax classes are a **fast-follow**, not this PR.

## Problem
Pharmacy renders as a relabelled retail clone. There is no way to mark a
product as prescription-only, no way for a customer to send a script, and
nothing stops an Rx order being fulfilled with no clinical check.

## Decisions
| # | Decision |
|---|---|
| R1 | **`products.requiresPrescription`** (bool, default false) — the Rx/OTC flag. Capability-gated to pharmacy so no other vertical grows an Rx concept. |
| R2 | **Review is a separate axis, not a new order status.** `orders.rxReviewStatus` (`not_required \| pending \| approved \| rejected`) **gates** the existing `pending → confirmed` transition. The shared 8-value `order_status` enum and every other vertical's state machine are untouched — the order genuinely IS pending; it *additionally* awaits a clinical check. |
| R3 | **A cart containing any Rx product requires a prescription AND a signed-in customer** (owner decision). Guests may still buy OTC-only carts, preserving P2's guest-checkout principle exactly where it still applies. |
| R4 | **Prescription images are PRIVATE.** The existing `/api/media-upload` is wrong twice over for this: it demands a *staff* dashboard session (a customer has none) and returns a **public** object URL. Rx uploads get their own route — customer-session authenticated, into a **private** bucket, and staff view them through short-lived signed URLs minted on demand. A prescription is medical data; a guessable public URL is not an acceptable store for it. |
| R5 | **Dedicated `pharmacist` role** + `rx:review` permission (owner decision). The audit trail then names a licensed person rather than "a manager". Owners also hold `rx:review` (a solo-pharmacist owner must be able to work); managers do **not** get it by default. |
| R6 | **Every review decision is audited** — `rx.submitted`, `rx.approved`, `rx.rejected` with the reviewing user, so the compliance trail answers "who cleared this, and when". |

## Data model (migration 0032)
- `products.requiresPrescription` — bool, default false.
- `orders.rxReviewStatus` — enum, default `not_required`.
- `prescriptions` (FORCE RLS): id, tenantId, customerId, orderId?, imagePath
  (storage path, **not** a public URL), status (`pending|approved|rejected`),
  reviewedByUserId?, reviewedAt?, rejectionReason?, createdAt.

## Flow
1. Customer adds an Rx product → storefront requires sign-in and a script upload.
2. `POST /api/prescriptions` (customer session) → private bucket, `prescriptions` row.
3. `placeOrder` sees an Rx line: requires `customerId` + a pending prescription,
   sets `rxReviewStatus = 'pending'`, links the prescription to the order.
4. Pharmacist opens the dashboard review queue, views the script via a signed
   URL, approves or rejects with a reason.
5. `transitionStatus` refuses `pending → confirmed` while `rxReviewStatus = 'pending'`;
   a rejection moves the order to `rejected` with the reason.

## Non-goals (v1)
Per-line tax classes / VAT-exempt medicines (**fast-follow**, filed separately —
it touches `computeOrderTotals`, the single money-math module, and deserves its
own PR) · repeat-prescription automation · pharmacist licence-number capture ·
drug-interaction checking · insurance claims.
