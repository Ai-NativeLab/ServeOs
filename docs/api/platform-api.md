# Platform, Storefront, Dashboard & Webhook Routes

Every route under `src/app/api/` that is not POS, inventory or purchasing. There is **no** `/api/admin/*` route: the admin console works entirely through Server Actions (see the [API index](./README.md#4-server-actions-catalog)).

Tenant resolution for storefront routes: the proxy (`src/proxy.ts`) classifies the host and, on a tenant subdomain, sets `x-tenant-slug`; routes that are called cross-host take `slug` as a query/body field instead. `/api/menu`, `/api/delivery-areas`, `POST /api/orders` and `/api/prescriptions` only serve tenants with status `active` or `trial` (`isTenantServable`); the status-token routes look the tenant up by slug without that check.

## Health

### GET /api/health — public
`{ ok: true, sha }` (`sha` is `VERCEL_GIT_COMMIT_SHA`, or `"dev"`). Deliberately touches no database; deploy-watch uses it to prove a build is serving traffic.

## Storefront (public / customer)

### GET /api/menu — public
Query: `slug` (required), `branch?`. Returns the published menu (`getPublishedMenu`). 400 without `slug`, 404 for an unknown or unservable tenant.

### GET /api/delivery-areas — public
Query: `slug`, `branch` (both required). Returns active areas: `{ id, nameEn, nameAr, deliveryFee, minOrderAmount, etaMinutes }[]`.

### POST /api/orders — public, customer session optional
Storefront checkout. If a `serveos_customer` cookie is valid for this tenant, the order is attached to that customer (never taken from the body).
```ts
{
  slug: string;
  locale?: "en" | "ar";                // language of error messages
  branchId: string;
  fulfillmentType: "pickup" | "delivery";
  customerName: string;
  customerPhone: string;
  notes?: string;
  areaId?: string; addressText?: string;   // delivery
  scheduledFor?: string;
  paymentMethod?: "cash" | "instapay" | "vodafone_cash" | "mobile_wallet";
  paymentReference?: string; paymentProofUrl?: string;  // required reference for non-cash methods
  lines: { productId: string; variantId?: string; quantity: number; selectedOptionIds?: string[];
           dimensions?: { lengthMm?: number; widthMm?: number; thicknessMm?: number } }[];
}
```
**201** `{ orderId, orderNumber, statusToken, total, itemIds }`. **422** `{ error, code }` for domain errors (e.g. `OutOfStockError`, `BranchNotAcceptingOrdersError`, `MinimumOrderNotMetError`, a prescription item ordered without a pending prescription). Non-cash methods start the order at `payment_status = pending_verification`.

### GET /api/orders/[token]/status — status token
Slug from `x-tenant-slug` or `?slug=`. Returns `{ status, paymentStatus, fulfillmentType }`.

### POST /api/orders/[token]/cancel — status token
Customer cancellation. Returns `{ status }`; **422** `{ error, code }` when the order can no longer be cancelled.

### POST /api/prescriptions — customer session required
Multipart form with `file`. Only on a storefront host (`x-surface: storefront`) whose vertical has the `prescriptionUpload` capability (pharmacy). The image goes to the **private** `prescriptions` storage bucket; the response is `{ id, status }` — never a URL. 401 when the customer is not signed in.

## Dashboard (staff session)

| Route | Guard | Response |
| :--- | :--- | :--- |
| `GET /api/dashboard/orders` | `orders:manage` | latest 100 orders as dashboard rows |
| `GET /api/dashboard/notifications` | any staff user | caller's notifications; query `unread=1`, `type`, `severity` |
| `POST /api/dashboard/notifications/mark-read` | any staff user | body `{ ids?: string[] }` (omit for all) → `{ ok: true }` |
| `GET /api/audit/events` | `audit:view` | audit events; query `action`, `entityType`, `entityId`, `actorUserId`, `actorType`, `from`, `to`, `limit` |
| `GET /api/audit/chain/status` | `audit:view` | result of verifying the tenant's hash chain (`getChainStatus`) |
| `POST /api/media-upload` | any staff user | multipart `type` (`category` \| `product` \| `banner` \| `logo` \| `cover`) + `file` (JPG/PNG/WebP/GIF, ≤ 5 MB) → `{ url }` in the Supabase Storage `media` bucket; 502 on a storage error |

## Demo

### GET /api/demo/login — public
Query: `trade`. Starts a session in the matching `demo-<trade>` tenant without credentials, sets `serveos_session`, and 303-redirects to `/dashboard`; an unknown or unseeded trade redirects back to `/#demo`. The demo tenants are reset nightly by `.github/workflows/demo-reset.yml`.

## Background & webhooks

### GET /api/notifications/worker — cron secret
`Authorization: Bearer $CRON_SECRET` (401 otherwise). Drains the email outbox and the WhatsApp order-status queue: `{ email, whatsapp }`. Scheduled in `vercel.json` (`0 3 * * *`).

### POST /api/notifications/webhook/[provider] — signature
Only `provider = resend`. Verifies the Svix signature over the raw body with `RESEND_WEBHOOK_SECRET` (503 if unset, 400 on a bad signature) and records the delivery event in `email_events`. Duplicates and untracked event types return 200 so the provider stops retrying.

### GET /api/whatsapp/webhook — Meta handshake
Echoes `hub.challenge` when `hub.mode=subscribe` and `hub.verify_token` equals `WHATSAPP_VERIFY_TOKEN`; 403 otherwise.

### POST /api/whatsapp/webhook — signature
Verifies `x-hub-signature-256` over the raw body (403 on failure), rejects bodies over 1 MB (413), and hands the payload to `ingestWebhook`. Always 200 on accepted work, because a non-2xx makes Meta retry.
