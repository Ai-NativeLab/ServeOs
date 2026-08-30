# Master API Reference Index

Welcome to the ServeOS Master API Reference Index. This document serves as the unified navigation hub and authentication guide for the ServeOS API surface, covering both RESTful endpoints (`/api/*`) and Next.js Server Actions.

ServeOS leverages a hybrid approach for its communication layer:
- **Client-to-Server**: RESTful API endpoints for external integrations, POS desktop applications, and specific client-side features.
- **Dashboard/Admin**: Next.js Server Actions for seamless, type-safe RPC-style mutations and data fetching within the App Router.

## 1. API Architecture Overview

### RESTful API Design
All RESTful endpoints are served under the `/api/*` path using Next.js 16 App Router Route Handlers (`route.ts`). The API adheres to standard REST principles:
- **GET**: Retrieve resources.
- **POST**: Create new resources or perform complex operations.
- **PUT / PATCH**: Update existing resources.
- **DELETE**: Remove resources.

### Standard Conventions
- **Request/Response Format**: Standard JSON (`application/json`) is used for all requests and responses unless specified otherwise (e.g., multipart forms for media uploads).
- **Date/Time**: All timestamps are formatted as ISO 8601 strings in UTC.
- **Pagination**: List endpoints support `limit` and `cursor` (or `offset`) query parameters.

### Error Response Schema
All non-2xx responses follow a standardized error format to ensure predictable client-side error handling:

```typescript
{
  "error": string, // Human-readable error message
  "code"?: string, // Machine-readable error code (e.g., "VALIDATION_FAILED", "UNAUTHORIZED")
  "details"?: unknown // Optional structured data containing specific validation or error details
}
```

---

## 2. Authentication & Authorization Models

ServeOS employs multiple authentication schemes tailored to the specific client and security requirements. 

| Auth Scheme | Description | Header / Cookie Example | Scope / Usage |
| :--- | :--- | :--- | :--- |
| **1. POS Device Bearer Token** | Device-level token authenticating a specific POS terminal to the backend. | `Authorization: Bearer <device_token>` | All `/api/pos/*` routes. Required for basic device connectivity. |
| **2. POS Cashier Token** | User-level token authenticating the specific employee operating the POS. | `X-POS-Cashier: <cashier_token>` | Specific `/api/pos/*` operations requiring user audit (e.g., refunds, shifts). |
| **3. Dashboard / Admin Cookie** | Standard HTTP-only, secure session cookie for web users. | `Cookie: serveos_session=<jwt>` <br> `serveos_admin_session=<jwt>` | Server Actions and dashboard API endpoints. Multi-tenant context encoded in token. |
| **4. Customer Session Cookie / Token** | Temporary tokens/cookies for public storefront and order tracking. | `Cookie: CUSTOMER_COOKIE=<token>` <br> `?token=<order_tracking_token>` | Customer-facing storefront and order status routes. |
| **5. Webhook Signatures** | Cryptographic verification for incoming third-party webhooks. | `svix-signature: <sig>` <br> `X-Hub-Signature-256: <hmac>` | `/api/webhooks/*` (Resend, WhatsApp). |
| **6. Public / Unauthenticated** | No authentication required. | *None* | Health checks, public menus, and delivery areas. |

---

## 3. Master Route Catalog (All 64 Endpoints)

The ServeOS API surface consists of 64 REST endpoints grouped by domain. 
For detailed schemas, request/response examples, and error codes, follow the links to the dedicated documentation files.

### [POS API Reference (`pos-api.md`)](./pos-api.md) — 24 Endpoints
| Method | Path | Auth Scheme | Permissions | Description |
| :--- | :--- | :--- | :--- | :--- |
| **POST** | `/api/pos/auth/register` | Device Token | None | Register a new POS terminal |
| **POST** | `/api/pos/auth/login` | Device Token | None | Authenticate POS terminal |
| **POST** | `/api/pos/cashier/login` | Device Token | PIN required | Authenticate cashier via PIN |
| **POST** | `/api/pos/cashier/logout` | Cashier Token | None | End cashier session |
| **GET** | `/api/pos/sync/menu` | Device Token | Menu:Read | Sync full menu data |
| **GET** | `/api/pos/sync/taxes` | Device Token | Tax:Read | Sync tax rates and rules |
| **GET** | `/api/pos/sync/discounts` | Device Token | Discount:Read | Sync applicable discounts |
| **POST** | `/api/pos/sync/offline-orders` | Device Token | Order:Write | Batch sync offline POS orders |
| **POST** | `/api/pos/orders` | Device/Cashier Token | Order:Write | Create a new POS order |
| **GET** | `/api/pos/orders/:id` | Device Token | Order:Read | Retrieve a specific order |
| **PUT** | `/api/pos/orders/:id` | Device/Cashier Token | Order:Write | Update an existing order |
| **POST** | `/api/pos/orders/:id/void` | Cashier Token | Order:Void | Void an order |
| **POST** | `/api/pos/orders/:id/refund` | Cashier Token | Order:Refund | Process a full/partial refund |
| **GET** | `/api/pos/payments/methods` | Device Token | Payment:Read | List accepted payment methods |
| **POST** | `/api/pos/payments/process` | Device/Cashier Token | Payment:Write | Process a payment transaction |
| **POST** | `/api/pos/shifts/open` | Cashier Token | Shift:Write | Open a cash register shift |
| **POST** | `/api/pos/shifts/close` | Cashier Token | Shift:Write | Close a cash register shift |
| **POST** | `/api/pos/shifts/cash-drop` | Cashier Token | Shift:Manage | Record a cash drop/payout |
| **GET** | `/api/pos/shifts/current` | Device Token | Shift:Read | Get current active shift info |
| **GET** | `/api/pos/customers` | Device Token | Customer:Read | Search/list customers |
| **POST** | `/api/pos/customers` | Device Token | Customer:Write | Create a new customer |
| **GET** | `/api/pos/hardware/printers` | Device Token | Hardware:Read | List configured network printers |
| **POST** | `/api/pos/hardware/print-job` | Device Token | Hardware:Write | Dispatch a receipt/kitchen ticket |
| **POST** | `/api/pos/logs` | Device Token | None | Ingest POS client error logs |

### [Inventory API Reference (`inventory-api.md`)](./inventory-api.md) — 14 Endpoints
| Method | Path | Auth Scheme | Permissions | Description |
| :--- | :--- | :--- | :--- | :--- |
| **GET** | `/api/inventory/items` | Session/Device | Inv:Read | List all inventory items |
| **POST** | `/api/inventory/items` | Session | Inv:Write | Create a new inventory item |
| **GET** | `/api/inventory/items/:id` | Session/Device | Inv:Read | Get specific item details |
| **PUT** | `/api/inventory/items/:id` | Session | Inv:Write | Update inventory item |
| **DELETE** | `/api/inventory/items/:id` | Session | Inv:Delete | Delete/archive an item |
| **GET** | `/api/inventory/locations` | Session | Inv:Read | List inventory storage locations |
| **POST** | `/api/inventory/adjustments` | Session | Inv:Write | Record stock adjustments |
| **GET** | `/api/inventory/adjustments` | Session | Inv:Read | List historical stock adjustments |
| **POST** | `/api/inventory/counts` | Session | Inv:Write | Start a physical inventory count |
| **PUT** | `/api/inventory/counts/:id` | Session | Inv:Write | Update/commit inventory count |
| **GET** | `/api/inventory/stock-levels` | Session/Device | Inv:Read | Get current stock levels |
| **POST** | `/api/inventory/transfers` | Session | Inv:Write | Transfer stock between locations |
| **GET** | `/api/inventory/transfers` | Session | Inv:Read | List stock transfers |
| **GET** | `/api/inventory/alerts` | Session | Inv:Read | Get low stock/expiry alerts |

### [Purchasing & Supplier API Reference (`purchasing-api.md`)](./purchasing-api.md) — 11 Endpoints
| Method | Path | Auth Scheme | Permissions | Description |
| :--- | :--- | :--- | :--- | :--- |
| **GET** | `/api/purchasing/suppliers` | Session | Supplier:Read | List all suppliers |
| **POST** | `/api/purchasing/suppliers` | Session | Supplier:Write | Add a new supplier |
| **GET** | `/api/purchasing/suppliers/:id` | Session | Supplier:Read | Get supplier details |
| **PUT** | `/api/purchasing/suppliers/:id` | Session | Supplier:Write | Update supplier details |
| **GET** | `/api/purchasing/purchase-orders` | Session | PO:Read | List purchase orders |
| **POST** | `/api/purchasing/purchase-orders` | Session | PO:Write | Create a purchase order |
| **GET** | `/api/purchasing/purchase-orders/:id` | Session | PO:Read | Get purchase order details |
| **PUT** | `/api/purchasing/purchase-orders/:id` | Session | PO:Write | Update purchase order |
| **POST** | `/api/purchasing/purchase-orders/:id/receive` | Session | PO:Write | Receive items against PO |
| **POST** | `/api/purchasing/purchase-orders/:id/cancel` | Session | PO:Write | Cancel a purchase order |
| **GET** | `/api/purchasing/invoices` | Session | Invoice:Read | List supplier invoices |

### [Platform API Reference (`platform-api.md`)](./platform-api.md) — 15 Endpoints
| Method | Path | Auth Scheme | Permissions | Description |
| :--- | :--- | :--- | :--- | :--- |
| **GET** | `/api/health` | Public | None | System health check |
| **GET** | `/api/menu` | Public | None | Public menu catalog for storefront |
| **GET** | `/api/delivery-areas` | Public | None | Supported delivery zones |
| **POST** | `/api/orders` | Customer Session | None | Customer order placement |
| **GET** | `/api/orders/:id/status` | Token (QS) | None | Public order status polling |
| **GET** | `/api/dashboard/metrics` | Session | Dash:Read | High-level business metrics |
| **GET** | `/api/admin/tenants` | Admin Session | Admin:Read | Superadmin: List tenants |
| **POST** | `/api/admin/tenants` | Admin Session | Admin:Write | Superadmin: Create tenant |
| **GET** | `/api/audit/logs` | Session | Audit:Read | Retrieve system audit logs |
| **POST** | `/api/media/upload` | Session | Media:Write | Request presigned upload URL |
| **POST** | `/api/webhooks/resend` | Webhook (Svix) | None | Email delivery status updates |
| **POST** | `/api/webhooks/whatsapp` | Webhook (HMAC) | None | WhatsApp message status |
| **POST** | `/api/notifications/push` | Session | Notif:Write | Send internal push notification |
| **GET** | `/api/notifications` | Session | Notif:Read | List unread notifications |
| **PUT** | `/api/notifications/read` | Session | Notif:Write | Mark notifications as read |

---

## 4. Server Actions Catalog (All 31 Files)

Server Actions are located across `src/app/**/actions.ts`. They provide type-safe data mutations directly from React Server Components and Client Components in the dashboard.
*Note: All dashboard server actions inherently require a valid Dashboard Session Cookie (`serveos_session`) and appropriate role-based permissions (RLS).*

| Domain | Module Path | Exported Actions (Examples) | Auth Context |
| :--- | :--- | :--- | :--- |
| **Auth** | `src/app/auth/actions.ts` | `login`, `logout`, `resetPassword` | Public / Session |
| **Tenants** | `src/app/(admin)/tenants/actions.ts` | `createTenant`, `updateTenantStatus` | Admin Session |
| **Users** | `src/app/settings/users/actions.ts` | `inviteUser`, `updateRole`, `revokeAccess` | Session |
| **Roles** | `src/app/settings/roles/actions.ts` | `createRole`, `updatePermissions` | Session |
| **Menu Items** | `src/app/menu/items/actions.ts` | `createMenuItem`, `updateMenuItem`, `archiveItem` | Session |
| **Categories** | `src/app/menu/categories/actions.ts` | `createCategory`, `reorderCategories` | Session |
| **Modifiers** | `src/app/menu/modifiers/actions.ts` | `createModifierGroup`, `linkModifierToItem` | Session |
| **Inventory** | `src/app/inventory/actions.ts` | `updateStockLevel`, `submitCount` | Session |
| **Suppliers** | `src/app/purchasing/suppliers/actions.ts` | `addSupplier`, `updateSupplier` | Session |
| **Purchase Orders** | `src/app/purchasing/orders/actions.ts` | `draftPO`, `approvePO`, `markReceived` | Session |
| **POS Devices** | `src/app/settings/devices/actions.ts` | `registerDevice`, `revokeDeviceToken` | Session |
| **Orders** | `src/app/orders/actions.ts` | `updateOrderStatus`, `refundOrder` | Session |
| **Customers** | `src/app/customers/actions.ts` | `updateCustomerProfile`, `addNote` | Session |
| **Promotions** | `src/app/marketing/promos/actions.ts` | `createDiscountCode`, `togglePromo` | Session |
| **Loyalty** | `src/app/marketing/loyalty/actions.ts` | `adjustPoints`, `updateLoyaltyTiers` | Session |
| **Reports** | `src/app/reports/actions.ts` | `generateSalesReport`, `exportCSV` | Session |
| **Taxes** | `src/app/settings/taxes/actions.ts` | `updateTaxRates`, `setTaxRules` | Session |
| **Locations** | `src/app/settings/locations/actions.ts` | `addLocation`, `updateOperatingHours` | Session |
| **Printers** | `src/app/settings/printers/actions.ts` | `configurePrinter`, `testPrint` | Session |
| **Webhooks** | `src/app/settings/integrations/actions.ts` | `addWebhookEndpoint`, `rotateSecret` | Session |
| **Billing** | `src/app/settings/billing/actions.ts` | `updateSubscription`, `addPaymentMethod` | Session |
| **Shifts** | `src/app/staff/shifts/actions.ts` | `approveShift`, `editTimecard` | Session |
| **Payroll** | `src/app/staff/payroll/actions.ts` | `generatePayrollReport` | Session |
| **Storefront** | `src/app/storefront/settings/actions.ts` | `updateTheme`, `updateStorefrontSEO` | Session |
| **Delivery** | `src/app/delivery/zones/actions.ts` | `createDeliveryZone`, `updateFees` | Session |
| **Drivers** | `src/app/delivery/drivers/actions.ts` | `registerDriver`, `assignOrderToDriver` | Session |
| **Feedback** | `src/app/feedback/actions.ts` | `respondToReview`, `flagReview` | Session |
| **Audit** | `src/app/settings/audit/actions.ts` | `exportAuditLogs` | Session |
| **WhatsApp** | `src/app/marketing/whatsapp/actions.ts` | `sendBroadcastTemplate`, `updateWhatsAppConfig` | Session |
| **Media** | `src/app/media/actions.ts` | `deleteMediaAsset`, `organizeMediaFolder` | Session |
| **Onboarding** | `src/app/onboarding/actions.ts` | `completeSetupStep`, `skipSetup` | Session |
