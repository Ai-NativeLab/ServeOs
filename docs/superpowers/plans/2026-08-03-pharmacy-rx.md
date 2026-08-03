# Pharmacy Rx Workflow (P3) — Implementation Plan

> Implements docs/superpowers/specs/2026-08-03-pharmacy-rx-design.md · issue #56.
> Next migration index: **0032**.

## Task 1 — Schema + capabilities
`products.requiresPrescription`, `orders.rxReviewStatus` (enum
`not_required|pending|approved|rejected`), `prescriptions` table (FORCE RLS,
stores an image PATH not a public URL). Capability flags
`prescriptionUpload`/`pharmacistReview`/`taxClasses` on VerticalCapabilities
(pharmacy: first two true, taxClasses false until the fast-follow; all others
false). Migration 0032 + hand-appended RLS. Tests: RLS isolation; capability
matrix per vertical; defaults.

## Task 2 — pharmacist role + rx:review permission
`RoleKey` gains `pharmacist`; `rx:review` permission held by `pharmacist` and
`owner` (a solo-pharmacist owner must be able to work), NOT manager/staff.
Tests: the matrix, explicitly asserting manager lacks it.

## Task 3 — prescriptions service
`submitPrescription(tenantId, customerId, imagePath)`, `reviewPrescription(
tenantId, id, {approved, reason}, audit)` → updates the prescription AND its
order's rxReviewStatus in one tx, `listPendingPrescriptions(tenantId)`,
`signedPrescriptionUrl(path)` (short TTL). Audits rx.submitted/approved/
rejected. Register in audit coverage. Tests: round-trip, rejection carries a
reason, RLS, audit rows name the reviewer.

## Task 4 — placeOrder Rx gate
Rx line ⇒ require `customerId` (owner decision R3) and a pending prescription;
set `rxReviewStatus='pending'` and link the prescription to the order. OTC-only
carts unchanged (guests fine). `transitionStatus` refuses `pending → confirmed`
while review is pending. Tests: Rx order without account rejected; without
prescription rejected; confirm blocked pre-approval and allowed post-approval;
OTC guest order provably unaffected.

## Task 5 — private upload route
`POST /api/prescriptions` — customer-session authenticated (P2's cookie), image
validation mirroring media-upload, into a PRIVATE bucket, returns the
prescription id (never a public URL). Staff read via signed URLs.

## Task 6 — surfaces
Dashboard `/dashboard/prescriptions` review queue (rx:review gated): script
image via signed URL, approve/reject with reason. Storefront: Rx badge on
product cards, sign-in + upload prompt in the sheet when a cart holds an Rx
item. Nav entry, capability-gated.

## Task 7 — verify + PR
Full suite, tsc, eslint, build. PR closes #56; files the per-line tax-classes
fast-follow issue.
