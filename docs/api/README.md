# API Reference Index

ServeOS exposes two kinds of server entry points:

- **Route handlers** (`src/app/api/**/route.ts`): JSON over HTTP, used by the Electron POS, the storefront, the dashboard's client components, cron jobs and third-party webhooks.
- **Server Actions** (`"use server"` files under `src/app/`): form/RPC mutations called from the dashboard, admin console, storefront account pages, login/register and the marketing enquiry form.

The catalogs below are **generated from source** (route files and their exported HTTP methods, plus the `authorize`/`assertPermission`/`resolve*Context` calls inside each handler). If you add or change a route, regenerate rather than hand-edit.

## 1. Conventions that actually hold

- **Body format:** JSON, except `POST /api/media-upload` and `POST /api/prescriptions`, which take `multipart/form-data`.
- **Errors:** handlers return `{ "error": string }` with the status code. Domain errors from the ordering service (`DomainError`) additionally carry a machine-readable `code` and are returned as **422** (`POST /api/orders`, `POST /api/orders/[token]/cancel`). There is no shared `details` field.
- **Auth failures:** staff routes built on `resolveInventoryContext` / `resolvePurchasingContext` return **401** with no session and **403** without the permission. `requireAuditPermission` routes return 403 on a missing permission; an unauthenticated caller gets the `/login` redirect thrown by `requireDashboardUser`. POS routes return **401** for a bad device or cashier token and **403** (`PosForbiddenError`) for a missing permission.
- **Dynamic params:** `params` is a `Promise` in this Next.js version and is awaited in every handler.
- **Pagination:** there is no global pagination convention. A few list endpoints take a `limit` (inventory items/counts, audit events) and the POS sales search takes `page`.

## 2. Authentication schemes

| Scheme | How it is presented | Verified by | Used by |
| :--- | :--- | :--- | :--- |
| **Staff session** | `serveos_session` cookie: an opaque random token looked up in the `sessions` table (not a JWT). The same cookie serves the dashboard and the admin console; admin pages additionally require the `super_admin` role. | `requireDashboardUser` (`src/server/auth/dashboard-context.ts`), `requireSuperAdmin` (`src/server/auth/admin-context.ts`) | Dashboard routes, dashboard/admin Server Actions |
| **Customer session** | `serveos_customer` cookie (`CUSTOMER_COOKIE`), validated against the storefront's tenant | `validateCustomerSession`, `currentCustomer` (`src/server/customers/`) | `POST /api/orders` (optional), `POST /api/prescriptions` (required), account Server Actions |
| **POS device** | `Authorization: Bearer <deviceToken>` (64 hex chars, from pairing) | `requirePosDevice` (`src/server/pos/require-device.ts`) | POS routes that act as the terminal |
| **POS device + cashier** | The device bearer **plus** `X-POS-Cashier: <cashierToken>` (12-hour cashier session, stored hashed in `pos_cashier_sessions`). Optional `X-POS-App-Version` goes into the audit fingerprint. | `requirePosCashier` (`src/server/pos/require-cashier.ts`) | POS routes that act for a human |
| **Status token** | Path segment `/api/orders/[token]/…` plus the tenant slug (`x-tenant-slug` header set by the proxy, or `?slug=`) | `getOrderByToken` / `cancelOrderByToken` | Customer order tracking |
| **Cron secret** | `Authorization: Bearer $CRON_SECRET` | inline check | `GET /api/notifications/worker` (Vercel Cron) |
| **Webhook signatures** | Resend: `svix-id` / `svix-timestamp` / `svix-signature` over the raw body. Meta: `x-hub-signature-256` HMAC over the raw body; `GET` handshake checks `hub.verify_token` against `WHATSAPP_VERIFY_TOKEN`. | `parseResendWebhook`, `ingestWebhook` | `/api/notifications/webhook/resend`, `/api/whatsapp/webhook` |
| **Public** | none | — | `/api/health`, `/api/menu`, `/api/delivery-areas`, `/api/pos/v1/pair`, `/api/pos/v1/login`, `/api/demo/login` |

Permission strings are defined in `src/server/rbac/permissions.ts`; the role → permission matrix is in [functional.md §4](../requirements/functional.md#4-roles-and-permissions).

## 3. Route catalog

"Staff session" + a permission means the handler calls `authorize(roleKeys, "<perm>")` (directly or through a `require*Permission` / `resolve*Context` helper). "Staff session" with no permission means any signed-in tenant user. POS routes marked "POS device + cashier" with no permission accept any signed-in cashier (cashier sign-in itself requires `pos:sell`).

**66 route files, 81 method handlers.**

### POS (`/api/pos/v1/*`) — 24 route files, 27 handlers ([pos-api.md](./pos-api.md))

| Method | Path | Auth | Permission | What it does |
|---|---|---|---|---|
| POST | `/api/pos/v1/authorize` | POS device + cashier | — | Manager override: verifies a manager's email/password and issues a short-lived grant |
| POST | `/api/pos/v1/cashier/login` | POS device | — | Cashier sign-in with email + password |
| GET | `/api/pos/v1/catalog` | POS device | — | Menu, checkout pricing, catalog version and shift policy for the device's branch |
| DELETE | `/api/pos/v1/held-tickets/[id]` | POS device + cashier | — | Discard a held ticket |
| GET | `/api/pos/v1/held-tickets` | POS device + cashier | — | List held tickets |
| POST | `/api/pos/v1/held-tickets` | POS device + cashier | — | Hold (park) a cart draft |
| POST | `/api/pos/v1/login` | Public | — | Owner/manager pairs a device with slug + email + password |
| GET | `/api/pos/v1/orders/list` | POS device | — | Live order queue for the device's branch (50 latest) |
| POST | `/api/pos/v1/orders/status` | POS device | — | Advance an order's status from the till |
| POST | `/api/pos/v1/pair` | Public | — | Redeem a pairing code for a device token |
| GET | `/api/pos/v1/ping` | POS device | — | Connectivity probe `{ ok, serverTime }` |
| GET | `/api/pos/v1/realtime` | POS device | — | Realtime topic config for the device's tenant, or `{ enabled: false }` |
| GET | `/api/pos/v1/reports/x` | POS device + cashier | `pos:sell` | X report |
| GET | `/api/pos/v1/reports/z` | POS device + cashier | `pos:sell` | Z report (`shiftId` optional) |
| POST | `/api/pos/v1/sales/[id]/payments` | POS device + cashier | `pos:sell` | Add a tender to a sale |
| POST | `/api/pos/v1/sales/[id]/refund` | POS device + cashier | `pos:sell` | Refund a sale (`pos:refund` or a manager grant resolved inside `issueRefund`) |
| POST | `/api/pos/v1/sales/[id]/reprint` | POS device + cashier | `pos:sell` | Receipt data for a reprint |
| GET | `/api/pos/v1/sales/[id]` | POS device + cashier | `pos:sell` | Sale detail |
| GET | `/api/pos/v1/sales` | POS device + cashier | `pos:sell` | Sales-history search |
| POST | `/api/pos/v1/sales` | POS device + cashier | `pos:sell` | Record a sale (idempotent on `clientOrderId`) |
| POST | `/api/pos/v1/shifts/close` | POS device + cashier | `pos:sell` | Close a shift with a final count; returns the Z report |
| GET | `/api/pos/v1/shifts/current` | POS device + cashier | `pos:sell` | Open shift on this device + live X report |
| POST | `/api/pos/v1/shifts/current` | POS device + cashier | `pos:sell` | Record a mid-shift count |
| POST | `/api/pos/v1/shifts/movements` | POS device + cashier | `pos:sell` | Pay-in / pay-out / safe drop / no-sale |
| POST | `/api/pos/v1/shifts/open` | POS device + cashier | `pos:sell` | Open a shift with an opening float |
| GET | `/api/pos/v1/sync/auth` | POS device + cashier | — | Offline sign-in roster (scrypt hashes) for POS-capable users |
| POST | `/api/pos/v1/sync/events` | POS device | — | Ingest a batch (≤ 50) of offline events |

### Inventory (`/api/inventory/*`) — 14 route files, 21 handlers ([inventory-api.md](./inventory-api.md))

| Method | Path | Auth | Permission | What it does |
|---|---|---|---|---|
| POST | `/api/inventory/adjustments` | Staff session | `inventory:manage` | Adjustment or waste ledger entry |
| POST | `/api/inventory/counts/[id]/commit` | Staff session | `inventory:count` | Commit a stock count (one `count` ledger row per discrepant line) |
| POST | `/api/inventory/counts/[id]/lines` | Staff session | `inventory:count` | Add/correct counted lines on an open count |
| GET | `/api/inventory/counts` | Staff session | `inventory:view` | List stock counts (`status`, `limit`) |
| POST | `/api/inventory/counts` | Staff session | `inventory:count` | Open a stock count (optionally with lines) |
| PATCH | `/api/inventory/items/[id]` | Staff session | `inventory:manage` | Edit an inventory item (not `baseUom`) |
| GET | `/api/inventory/items` | Staff session | `inventory:view` | List inventory items (`kind`, `isActive`, `limit`) |
| POST | `/api/inventory/items` | Staff session | `inventory:manage` | Create an inventory item |
| GET | `/api/inventory/on-hand` | Staff session | `inventory:view` | On-hand by item/location (+ lots when `itemId` given) |
| GET | `/api/inventory/product-links` | Staff session | `inventory:view` | List product → inventory links |
| POST | `/api/inventory/product-links` | Staff session | `inventory:manage` | Link a product/variant to a recipe or finished-good item |
| DELETE | `/api/inventory/product-links` | Staff session | `inventory:manage` | Unlink (`productId`, optional `variantId`) |
| POST | `/api/inventory/receipts` | Staff session | `inventory:manage` | Receive stock outside a PO (creates a lot + `receive` ledger row) |
| GET | `/api/inventory/recipes/[id]` | Staff session | `inventory:view` | Get a recipe with components |
| PATCH | `/api/inventory/recipes/[id]` | Staff session | `inventory:manage` | Edit recipe header and/or replace components |
| GET | `/api/inventory/recipes` | Staff session | `inventory:view` | List recipes |
| POST | `/api/inventory/recipes` | Staff session | `inventory:manage` | Create a recipe (BOM) |
| GET | `/api/inventory/reorder-rules` | Staff session | `purchasing:manage` | List reorder rules |
| PUT | `/api/inventory/reorder-rules` | Staff session | `purchasing:manage` | Upsert a reorder rule |
| POST | `/api/inventory/reorder/check` | Staff session | `purchasing:manage` | Run the reorder sweep now (same function as `reorder-check.yml`) |
| POST | `/api/inventory/transfers` | Staff session | `inventory:manage` | Move stock between two locations |

### Purchasing & suppliers — 11 route files, 15 handlers ([purchasing-api.md](./purchasing-api.md))

| Method | Path | Auth | Permission | What it does |
|---|---|---|---|---|
| POST | `/api/purchase-orders/[id]/cancel` | Staff session | `purchasing:manage` | Cancel a PO |
| POST | `/api/purchase-orders/[id]/close` | Staff session | `purchasing:manage` | Close a received PO |
| PATCH | `/api/purchase-orders/[id]/invoice` | Staff session | `purchasing:manage` | Record the supplier invoice total |
| POST | `/api/purchase-orders/[id]/receipts` | Staff session | `purchasing:manage` | Post a goods receipt against PO lines |
| GET | `/api/purchase-orders/[id]` | Staff session | `purchasing:manage` | PO detail |
| PATCH | `/api/purchase-orders/[id]` | Staff session | `purchasing:manage` | Replace a draft PO's supplier/branch/lines |
| POST | `/api/purchase-orders/[id]/send` | Staff session | `purchasing:manage` | Email the PO to the supplier and mark it `sent` |
| GET | `/api/purchase-orders/[id]/variance` | Staff session | `purchasing:manage` | Ordered vs received vs invoiced variance |
| GET | `/api/purchase-orders` | Staff session | `purchasing:manage` | List POs (`status`) |
| POST | `/api/purchase-orders` | Staff session | `purchasing:manage` | Create a draft PO |
| GET | `/api/suppliers/[id]/items` | Staff session | `suppliers:manage` | Supplier's item catalog |
| POST | `/api/suppliers/[id]/items` | Staff session | `suppliers:manage` | Upsert a supplier item (SKU, last cost, pack UoM) |
| PATCH | `/api/suppliers/[id]` | Staff session | `suppliers:manage` | Update a supplier |
| GET | `/api/suppliers` | Staff session | `suppliers:manage` | List suppliers |
| POST | `/api/suppliers` | Staff session | `suppliers:manage` | Create a supplier |

### Platform, storefront, dashboard & webhooks — 17 route files, 18 handlers ([platform-api.md](./platform-api.md))

| Method | Path | Auth | Permission | What it does |
|---|---|---|---|---|
| GET | `/api/audit/chain/status` | Staff session | `audit:view` | Verify the tenant's audit hash chain (`getChainStatus`) |
| GET | `/api/audit/events` | Staff session | `audit:view` | Filtered audit-event list (`action`, `entityType`, `entityId`, `actorUserId`, `actorType`, `from`, `to`, `limit`) |
| POST | `/api/dashboard/notifications/mark-read` | Staff session | — | Mark the caller's notifications read (`ids` optional = all) |
| GET | `/api/dashboard/notifications` | Staff session | — | Caller's notifications (`unread=1`, `type`, `severity`) |
| GET | `/api/dashboard/orders` | Staff session | `orders:manage` | Latest 100 orders as dashboard rows (live-queue polling) |
| GET | `/api/delivery-areas` | Public | — | Active delivery areas for `slug` + `branch` |
| GET | `/api/demo/login` | Public | — | Signs the visitor into the `demo-<trade>` tenant, sets `serveos_session`, 303 → `/dashboard` |
| GET | `/api/health` | Public | — | `{ ok, sha }` — DB-free liveness probe used by deploy-watch |
| POST | `/api/media-upload` | Staff session | — | Multipart image upload to the Supabase Storage `media` bucket (max 5 MB) |
| GET | `/api/menu` | Public | — | Published menu for `slug` (optional `branch`) |
| POST | `/api/notifications/webhook/[provider]` | Resend (Svix) signature | — | Email delivery events; only `resend` is accepted |
| GET | `/api/notifications/worker` | Cron secret | — | Drains the notification outbox and WhatsApp status queue (Vercel Cron) |
| POST | `/api/orders/[token]/cancel` | Public | — | Customer cancels an order by status token |
| GET | `/api/orders/[token]/status` | Public | — | Order status by status token |
| POST | `/api/orders` | Public | — | Storefront checkout (`placeOrder`); attaches the signed-in customer if any |
| POST | `/api/prescriptions` | Customer session | — | Customer uploads a prescription image (pharmacy storefronts only) |
| GET | `/api/whatsapp/webhook` | Meta verify token | — | Meta subscription handshake (`hub.verify_token`) |
| POST | `/api/whatsapp/webhook` | Meta HMAC signature | — | Inbound WhatsApp messages/statuses |


## 4. Server Actions catalog

Every exported function in these files is a Server Action. "Guard" is the auth helper the action calls; "Permission" is what that helper (or a direct `authorize` call) enforces. Actions listed with "no guard" are sign-in/sign-up/sign-out or the public marketing enquiry form.

**32 `"use server"` files, 84 exported actions.**


#### `src/app/account/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `customerRegisterAction` | no guard | — |
| `customerLoginAction` | no guard | — |
| `customerSignOutAction` | no guard | — |
| `customerUpdateProfileAction` | `currentCustomer` | — |

#### `src/app/admin/(console)/approvals/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `approveAction` | `requireSuperAdmin` | super_admin role |
| `rejectAction` | `requireSuperAdmin` | super_admin role |

#### `src/app/admin/(console)/billing/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `confirmInvoiceAction` | `requireSuperAdmin` | super_admin role |
| `rejectInvoiceAction` | `requireSuperAdmin` | super_admin role |

#### `src/app/admin/(console)/tenants/[id]/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `cancelSubscriptionAction` | `requireSuperAdmin` | super_admin role |
| `forceActiveAction` | `requireSuperAdmin` | super_admin role |
| `markPaidAction` | `requireSuperAdmin` | super_admin role |
| `suspendTenantAction` | `requireSuperAdmin` | super_admin role |
| `activateTenantAction` | `requireSuperAdmin` | super_admin role |

#### `src/app/admin/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `adminSignOutAction` | no guard | — |

#### `src/app/admin/login/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `adminLoginAction` | no guard | — |

#### `src/app/dashboard/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `signOutAction` | no guard | — |

#### `src/app/dashboard/banners/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `createBannerAction` | `requireMenuPermission` | `menu:manage` |
| `toggleBannerAction` | `requireMenuPermission` | `menu:manage` |
| `deleteBannerAction` | `requireMenuPermission` | `menu:manage` |

#### `src/app/dashboard/branches/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `createBranchAction` | `requireMenuPermission` | `menu:manage` |
| `updateBranchAction` | `requireMenuPermission` | `menu:manage` |
| `deleteBranchAction` | `requireMenuPermission` | `menu:manage` |

#### `src/app/dashboard/customers/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `setTradeApprovalAction` | `requireCustomersPermission` | `customers:manage` |

#### `src/app/dashboard/inventory/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `createItemAction` | `requireInventoryPermission` | `inventory:manage` |
| `receiveStockAction` | `requireInventoryPermission` | `inventory:manage` |
| `adjustStockAction` | `requireInventoryPermission` | `inventory:manage` |
| `transferStockAction` | `requireInventoryPermission` | `inventory:manage` |
| `createRecipeAction` | `requireInventoryPermission` | `inventory:manage` |
| `setRecipeComponentsAction` | `requireInventoryPermission` | `inventory:manage` |
| `linkProductAction` | `requireInventoryPermission` | `inventory:manage` |
| `unlinkProductAction` | `requireInventoryPermission` | `inventory:manage` |

#### `src/app/dashboard/menu/categories/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `createCategoryAction` | `requireMenuPermission` | `menu:manage` |
| `updateCategoryAction` | `requireMenuPermission` | `menu:manage` |
| `deleteCategoryAction` | `requireMenuPermission` | `menu:manage` |

#### `src/app/dashboard/menu/products/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `createProductAction` | `requireMenuPermission` | `menu:manage` |
| `updateProductAction` | `requireMenuPermission` | `menu:manage` |
| `deleteProductAction` | `requireMenuPermission` | `menu:manage` |
| `upsertModifierGroupAction` | `requireMenuPermission` | `menu:manage` |
| `deleteModifierGroupAction` | `requireMenuPermission` | `menu:manage` |
| `upsertModifierOptionAction` | `requireMenuPermission` | `menu:manage` |
| `deleteModifierOptionAction` | `requireMenuPermission` | `menu:manage` |
| `setBranchAvailabilityAction` | `requireMenuPermission` | `menu:manage` |
| `upsertVariantAction` | `requireMenuPermission` | `menu:manage` |
| `deleteVariantAction` | `requireMenuPermission` | `menu:manage` |
| `setProductStockAction` | `requireMenuPermission` | `menu:manage` |

#### `src/app/dashboard/orders/[id]/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `transitionOrderAction` | `requireOrdersPermission` | `orders:manage` |
| `markPaidAction` | `requireOrdersPermission` | `orders:manage` |

#### `src/app/dashboard/orders/[id]/refund-actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `issueRefundAction` | `requireOrdersPermission`, `authorize` | `pos:refund`, `orders:manage` |

#### `src/app/dashboard/payments/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `confirmOrderPaymentAction` | `requireDashboardUser`, `authorize` | `payments:confirm` |
| `rejectOrderPaymentAction` | `requireDashboardUser`, `authorize` | `payments:confirm` |

#### `src/app/dashboard/prescriptions/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `reviewPrescriptionAction` | `requireRxReviewPermission` | `rx:review` |

#### `src/app/dashboard/purchase-orders/[id]/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `sendPoAction` | `requirePurchasingPermission` | `purchasing:manage` |
| `cancelPoAction` | `requirePurchasingPermission` | `purchasing:manage` |
| `closePoAction` | `requirePurchasingPermission` | `purchasing:manage` |
| `enterInvoiceAction` | `requirePurchasingPermission` | `purchasing:manage` |
| `postReceiptAction` | `requirePurchasingPermission` | `purchasing:manage` |

#### `src/app/dashboard/purchase-orders/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `createDraftPoAction` | `requirePurchasingPermission` | `purchasing:manage` |
| `updateDraftPoAction` | `requirePurchasingPermission` | `purchasing:manage` |

#### `src/app/dashboard/purchase-orders/reorder-rules/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `upsertReorderRuleAction` | `requirePurchasingPermission` | `purchasing:manage` |
| `runReorderCheckAction` | `requirePurchasingPermission` | `purchasing:manage` |

#### `src/app/dashboard/settings/billing/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `requestUpgradeAction` | `requireBillingPermission` | `billing:manage` |
| `subscribeToPlanAction` | `requireBillingPermission` | `billing:manage` |
| `submitInvoiceProofAction` | `requireBillingPermission` | `billing:manage` |

#### `src/app/dashboard/settings/fulfillment/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `setAcceptingOrdersAction` | `requireFulfillmentPermission` | `fulfillment:manage` |
| `setOpeningHoursAction` | `requireFulfillmentPermission` | `fulfillment:manage` |
| `addAreaAction` | `requireFulfillmentPermission` | `fulfillment:manage` |
| `deleteAreaAction` | `requireFulfillmentPermission` | `fulfillment:manage` |
| `setVatAction` | `requireFulfillmentPermission` | `fulfillment:manage` |

#### `src/app/dashboard/settings/payment-methods/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `saveOfflineMethodAction` | `requireDashboardUser`, `authorize` | `fulfillment:manage` |
| `deleteOfflineMethodAction` | `requireDashboardUser`, `authorize` | `fulfillment:manage` |

#### `src/app/dashboard/settings/pos-devices/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `generatePairingCodeAction` | `requireTenantManagePermission` | `tenant:manage` |
| `revokeDeviceAction` | `requireTenantManagePermission` | `tenant:manage` |

#### `src/app/dashboard/settings/profile/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `updateTenantProfileAction` | `requireTenantManagePermission` | `tenant:manage` |

#### `src/app/dashboard/settings/staff/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `createStaffAction` | `requireStaffPermission` | `staff:invite` |
| `setStaffRoleAction` | `requireStaffPermission` | `staff:invite` |
| `deactivateStaffAction` | `requireStaffPermission` | `staff:invite` |

#### `src/app/dashboard/settings/taxes/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `saveTaxSettingsAction` | `requireDashboardUser`, `authorize` | `fulfillment:manage` |

#### `src/app/dashboard/settings/whatsapp/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `setWhatsappNumberAction` | `requireFulfillmentPermission` | `fulfillment:manage` |

#### `src/app/dashboard/suppliers/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `createSupplierAction` | `requirePurchasingPermission` | `suppliers:manage` |
| `updateSupplierAction` | `requirePurchasingPermission` | `suppliers:manage` |
| `upsertSupplierItemAction` | `requirePurchasingPermission` | `suppliers:manage` |

#### `src/app/login/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `loginAction` | no guard | — |

#### `src/app/register/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `registerAction` | no guard | — |

#### `src/app/subscribe/actions.ts`

| Action | Guard | Permission |
|---|---|---|
| `submitEnquiryAction` | no guard | — |
