# POS API Reference (`/api/pos/v1/*`)

Consumed by the Electron till (`apps/pos`). The Electron main process (`apps/pos/electron/pos-main.ts`) holds the tokens and makes these calls; the renderer never sees them. Request/response shapes below are taken from the route handlers in `src/app/api/pos/v1/` and the service types they call.

## Authentication

| Level | Headers | Helper | Failure |
| :--- | :--- | :--- | :--- |
| Public | none | — | — |
| Device | `Authorization: Bearer <deviceToken>` | `requirePosDevice` | 401 `{ error: "Unauthorized" }` |
| Device + cashier | device bearer **and** `X-POS-Cashier: <cashierToken>`; optional `X-POS-App-Version` | `requirePosCashier` | 401 for a bad device or cashier token, 403 for a missing permission |

- The **device token** is a 64-hex-char opaque token minted at pairing. It identifies the tenant and branch; the tenant/branch is never taken from the request body. Revoke a device from **Dashboard → Settings → POS devices** (`revokeDeviceAction`).
- The **cashier token** comes from `POST /cashier/login`. It is stored hashed in `pos_cashier_sessions` and lasts 12 hours. A cashier token minted for another tenant is rejected.
- **Permissions** are the cashier's `pos:*` and `reconciliation:manage` permissions, snapshotted at sign-in. Routes that need more than `pos:sell` (discounts, refunds, over-threshold pay-outs, cross-cashier close) resolve it inside the service: either the cashier holds the permission, or the request carries a **manager grant** from `POST /authorize`.

---

## Device & sign-in

### POST /api/pos/v1/pair
Redeems a pairing code minted in the dashboard (**Settings → POS devices**, `generatePairingCodeAction`). Codes are **8 uppercase alphanumeric characters** and expire **10 minutes** after minting (`src/server/pos/service.ts`). Single use.

- **Auth:** public
- **Body:** `{ code: string }` (trimmed and upper-cased server-side)
- **200:** `{ deviceToken: string, tenantId: string, branchId: string, branchName: string }`
- **400:** `{ error }` for a missing, unknown, used or expired code

### POST /api/pos/v1/login
Alternative to a pairing code: an owner/manager pairs the device with their own credentials.

- **Auth:** public
- **Body:** `{ slug: string, email: string, password: string, branchId?: string }`
- **200:** either `{ status: "branch_required", branches: { id, name }[] }` (call again with `branchId`) or `{ status: "paired", deviceToken, tenantId, branchId, branchName }`
- **400:** missing slug/email/password · **401:** `{ error }` (`PosLoginError`)

### POST /api/pos/v1/cashier/login
Signs a human in on a paired device with **email + password** (there is no PIN). The account must be active in the device's tenant and hold `pos:sell`.

- **Auth:** device
- **Body:** `{ email: string, password: string }`
- **200:** `{ cashierToken: string, userId: string, name: string, permissions: Permission[] }`
- **400:** missing fields · **401:** bad credentials or "This account is not allowed to use the POS"

### POST /api/pos/v1/authorize
Manager override. A manager types their own email + password on the till; the server checks they hold the requested permission and returns a short-lived grant token (2 minutes, `GRANT_TTL_MS` in `src/server/pos/grants.ts`) that the cashier's next request passes in `grants` / `grantToken`. Writes an `authz.manager_granted` audit event.

- **Auth:** device + cashier
- **Body:** `{ email: string, password: string, permission: string }` — `permission` must be a `pos:*` permission or `reconciliation:manage`
- **200:** `{ grant: string, authorizedBy: string }` (`authorizedBy` is the manager's name)
- **400:** missing fields or a non-grantable permission · **401:** bad manager credentials / manager lacks the permission

### GET /api/pos/v1/ping
- **Auth:** device
- **200:** `{ ok: true, serverTime: string }`

---

## Catalog, realtime & sync

### GET /api/pos/v1/catalog
- **Auth:** device
- **200:** `{ menu, pricing, catalogVersion, shiftPolicy, syncedAt }` — `menu` is `getPublishedMenu` for the device's branch, `pricing` is `getCheckoutPricing`, `shiftPolicy` carries the pay-out threshold / blind-close settings the till needs offline.

### GET /api/pos/v1/realtime
- **Auth:** device
- **200:** `{ enabled: true, config }` when Supabase Realtime is configured for the deployment, otherwise `{ enabled: false }` (the till then keeps polling). See `docs/references/realtime.md`.

### GET /api/pos/v1/sync/auth
Roster for **offline** cashier sign-in: every user in the tenant holding a `pos:*` permission or `reconciliation:manage`, with their scrypt password hash. Gated on a signed-in cashier, and the pull itself is audited (the roster is not logged).

- **Auth:** device + cashier
- **200:** `{ users: { userId, name, email, passwordHash, permissions }[], syncedAt }`

### POST /api/pos/v1/sync/events
Ingests events the till queued while offline. Device-authenticated only: every event carries its own `actorUserId`, so one batch may span cashiers.

- **Auth:** device
- **Body:** `{ events: SyncEvent[] }`, at most **50** per request
  ```ts
  type SyncEvent = {
    eventId: string; seq: number; occurredAt: string; actorUserId: string;
    authorizedByUserId?: string;           // offline stand-in for a manager grant
    type: "sale.recorded" | "shift.opened" | "shift.closed" | "cash.movement" | "count.recorded"
        | "ticket.held" | "ticket.recalled" | "ticket.discarded" | "grant.issued" | "session.signed_in";
    payload: Record<string, unknown>;
  };
  ```
- **200:** `{ results: ({ eventId, status: "applied" | "duplicate", result, flags? } | { eventId, status: "failed", error: { code, message } })[] }`
- **400:** missing `events`, or more than 50

---

## Shifts & cash drawer

All shift routes require device + cashier and `pos:sell`.

| Route | Body | 200 response | Notable errors |
| :--- | :--- | :--- | :--- |
| `POST /shifts/open` | `{ openingFloat: number, denominations?: Record<string, number> }` | `{ shift }` | 409 shift already open · 400 denominations don't sum to the float |
| `GET /shifts/current` | — | `{ shift, report }` (X report), or `{ shift: null, report: null }` | — |
| `POST /shifts/current` | `{ countedTotal: number, denominations? }` (mid-shift count) | `{ count, report }` | 409 no open shift / shift closed |
| `POST /shifts/movements` | `{ type, amount, reasonCode, reasonText?, grants? }` — `type` is `pay_in`, `pay_out`, `safe_drop` or `no_sale` | `{ movement }` | 409 no open shift · 400 invalid movement · 403 over-threshold pay-out without `reconciliation:manage` or a grant |
| `POST /shifts/close` | `{ count: { countedTotal, denominations? }, grants?, shiftId? }` | `{ report }` (Z report) | 409 no open shift / already closed · 400 count mismatch · 403 closing another cashier's drawer or settling a flagged variance needs `reconciliation:manage` or a grant |

Only one shift can be open per device: unique index `pos_shifts_device_open` on `device_id WHERE status = 'open'`.

## Sales

All sales routes require device + cashier and `pos:sell`.

### POST /api/pos/v1/sales
- **Body** (`RecordSaleInput`): `{ clientOrderId, lines, expectedTotal, payments: TenderInput[], orderDiscountAmount?, orderDiscountReason?, grants?, notes? }`
  - `lines` are `PlaceOrderLine`s (`productId`, `variantId?`, `quantity`, `selectedOptionIds`, `dimensions?`)
  - `TenderInput`: `{ clientPaymentId, method: "cash" | "card" | "other", amount, tipAmount?, tenderedAmount?, reference? }`
  - `grants`: `{ permission, token }[]` from `POST /authorize` (e.g. `pos:discount`)
- **Idempotent** on `(deviceId, clientOrderId)` via `pos_order_receipts`: a retry returns the original receipt.
- **200:** the receipt
- **409:** `{ error: "Prices have changed — review the cart", expected, actual }` when `expectedTotal` disagrees with the server total; or "Open a shift before taking cash"
- **403:** discount without `pos:discount` / grant · **400:** out of stock, validation, `PosSaleError`

### GET /api/pos/v1/sales
Sales-history search. Query: `from`, `to` (dates), `cashier`, `phone`, `orderNumber`, `amount`, `branchId`, `page`. 200 is the `listSales` result.

### GET /api/pos/v1/sales/[id] · POST /api/pos/v1/sales/[id]/reprint
Sale detail / receipt data for a reprint. 404 `{ error: "Sale not found" }`.

### POST /api/pos/v1/sales/[id]/payments
Adds a tender to an existing sale. Body is a `TenderInput` (`clientPaymentId`, `method`, `amount` required). Returns the receipt; the order's `payment_status` becomes `paid` or `partially_paid`. 409 with no open shift.

### POST /api/pos/v1/sales/[id]/refund
- **Body** (`RefundInput` minus `orderId`): `{ clientRefundId, kind: "full" | "partial", lines, payments, reasonCode, reasonText?, shiftId?, grantToken? }` — each line carries a `restock` flag.
- The route asserts only `pos:sell`; `issueRefund` then requires `pos:refund` or a valid `grantToken` (403 otherwise).
- **200:** the `RefundResult` · **400:** validation / `PosRefundError`

## Order queue

### GET /api/pos/v1/orders/list
- **Auth:** device
- **200:** `{ orders: { id, orderNumber, customerName, fulfillmentType, total, status, paymentStatus, placedAt, source: "walkin" | "online" }[], syncedAt }` — the 50 latest orders for the device's branch.

### POST /api/pos/v1/orders/status
- **Auth:** device (attributed to the user who paired the device)
- **Body:** `{ orderId: string, toStatus: "confirmed" | "preparing" | "ready" | "completed" | "cancelled" }`
- **200:** `{ id, status }`. The order state machine still applies (see [state-machines.md](../flows/state-machines.md)).

## Held tickets

Device + cashier; no permission beyond a signed-in cashier.

| Route | Body | 200 |
| :--- | :--- | :--- |
| `GET /held-tickets` | — | `{ tickets }` |
| `POST /held-tickets` | `{ label?: string, draft: unknown }` | `{ id, idempotent }` |
| `DELETE /held-tickets/[id]` | — | `{ ok: true }` |

## Reports

Device + cashier and `pos:sell` (not plan-gated).

- `GET /api/pos/v1/reports/x` — X report: today's sold POS totals for the branch (tenant timezone) plus the expected drawer cash.
- `GET /api/pos/v1/reports/z?shiftId=` — Z report: the X figures plus the shift's counted cash and over/short; `shiftId` optional.
