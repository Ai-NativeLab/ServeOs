# ServeOS QA: Master User Journeys and Test Scenarios

**Document ID:** QA-DOC-001  
**GitHub Issue:** [#142](https://github.com/Ai-NativeLab/ServeOs/issues/142)  
**Date:** 2026-08-18  
**Status:** Draft — Ready for Review  
**Target Environments:** Local Dev (`serveos.localhost:3000`), QA Staging (`qa.serveos.tech`), Production (`serveos.tech`)

---

## Table of Contents
1. [Executive Summary & Scope](#1-executive-summary--scope)
2. [Surface & Persona Matrix](#2-surface--persona-matrix)
3. [End-to-End User Journeys](#3-end-to-end-user-journeys)
   - [Journey 1: Tenant Registration, Admin Approval & Onboarding](#journey-1-tenant-registration-admin-approval--onboarding)
   - [Journey 2: Customer Ordering, Offline Payment & Kitchen Fulfillment](#journey-2-customer-ordering-offline-payment--kitchen-fulfillment)
   - [Journey 3: In-Store POS Register, Shift Management & Cash Reconciliation](#journey-3-in-store-pos-register-shift-management--cash-reconciliation)
   - [Journey 4: Inventory Recipes (BOM), Auto-Deduction & Purchasing](#journey-4-inventory-recipes-bom-auto-deduction--purchasing)
   - [Journey 5: Multi-Vertical Adaptation (Restaurant, Retail, Pharmacy, Timber)](#journey-5-multi-vertical-adaptation)
   - [Journey 6: Multi-Tenant Data Isolation (RLS) & Tamper-Evident Audit](#journey-6-multi-tenant-data-isolation-rls--tamper-evident-audit)
   - [Journey 7: Offline Resilience, PWA Caching & Localization (AR/EN)](#journey-7-offline-resilience-pwa-caching--localization-aren)
4. [Master Test Scenario Catalog](#4-master-test-scenario-catalog)
   - [4.1 Onboarding & Authentication (`TC-AUTH`)](#41-onboarding--authentication-tc-auth)
   - [4.2 Storefront PWA Customer Experience (`TC-STORE`)](#42-storefront-pwa-customer-experience-tc-store)
   - [4.3 Merchant Dashboard Operations (`TC-DASH`)](#43-merchant-dashboard-operations-tc-dash)
   - [4.4 Electron POS Desktop App (`TC-POS`)](#44-electron-pos-desktop-app-tc-pos)
   - [4.5 Platform Admin Console (`TC-ADMIN`)](#45-platform-admin-console-tc-admin)
   - [4.6 Security, RLS & Audit Integrity (`TC-SEC`)](#46-security-rls--audit-integrity-tc-sec)
   - [4.7 Internationalization, RTL & Responsiveness (`TC-I18N`)](#47-internationalization-rtl--responsiveness-tc-i18n)
5. [Test Automation Coverage & Gap Analysis](#5-test-automation-coverage--gap-analysis)
6. [QA Execution Runbook](#6-qa-execution-runbook)

---

## 1. Executive Summary & Scope

ServeOS is a multi-tenant commerce and operations operating system serving restaurants, retail stores, pharmacies, and timber merchants. The platform architecture integrates host-based subdomains, PostgreSQL Row-Level Security (RLS), an Electron POS desktop application, and installable customer PWAs.

### Objectives of this QA Specification:
- Establish a single source of truth for all testing efforts across all 5 user-facing surfaces.
- Provide end-to-end user journeys that cross surface boundaries (e.g. Storefront $\rightarrow$ Dashboard $\rightarrow$ POS $\rightarrow$ Admin).
- Detail explicit, reproducible test scenarios with preconditions, action sequences, expected outcomes, and edge cases.
- Classify scenarios by automation feasibility (Vitest unit/integration vs. Playwright browser E2E vs. Manual exploratory testing).

---

## 2. Surface & Persona Matrix

### 2.1 Surfaces Under Test
| Surface ID | Surface Name | Routing / Hostname Pattern | Tech Stack / Interface | Primary Purpose |
|---|---|---|---|---|
| **S1** | **Marketing Site** | `www.serveos.tech` / `serveos.localhost:3000` | Next.js Server Components, CSS Modules | Public landing, pricing, vertical demos, lead capture, i18n switcher |
| **S2** | **Customer Storefront** | `{slug}.serveos.tech` / `{slug}.serveos.localhost:3000` | Next.js App Router, PWA, Service Worker | Customer menu browsing, cart, modifiers, checkout, payment proof upload, order tracking |
| **S3** | **Merchant Dashboard** | `app.serveos.tech` / `app.serveos.localhost:3000` | Next.js React Server/Client Components | Store setup, catalog/menu, live orders, inventory/BOM, POs, reports, settings |
| **S4** | **Platform Admin Console** | `admin.serveos.tech` / `admin.serveos.localhost:3000/admin` | Next.js Admin App Router | Tenant approval/suspension, plan entitlement overrides, billing verification, audit logs |
| **S5** | **Electron Desktop POS** | `apps/pos` (Desktop Application) | Electron + Vite + React (Context Bridge) | Till sales, cash drawer shifts, split payments, refunds, offline sync, X/Z reports |
| **S6** | **API & Headless Services** | `/api/*`, `/api/pos/v1/*` | Next.js Route Handlers, Drizzle ORM | Secure data mutations, POS device sync, tenant RLS isolation, audit logging |

### 2.2 User Personas & Permissions
| Persona ID | Role | Surface Access | Typical Credentials (Dev/Seed) | Permissions & Capabilities |
|---|---|---|---|---|
| **P1** | **Platform Super Admin** | S4 (`admin.*`) | `admin@serveos.com` / `admin1234` | Full platform control, approve tenants, manage global subscriptions, view system-wide logs |
| **P2** | **Tenant Owner** | S3 (`app.*`) | `owner@roma.com` / `owner1234` (Slug: `roma`) | Full tenant control: billing, staff invites, branch config, POS pairing, bank details |
| **P3** | **Branch Manager** | S3 (`app.*`) | `manager@roma.com` / `manager1234` | Menu management, inventory/PO creation, shift review, customer database, reports |
| **P4** | **Kitchen / Dispatch Staff** | S3 (`app.*`) | `staff@roma.com` / `staff1234` | Live order processing: accept, mark preparing, ready for pickup, dispatch, complete |
| **P5** | **POS Cashier** | S5 (`apps/pos`) | Staff PIN / Cashier Code on registered device | Open/close shifts, ring sales, apply approved discounts, record cash movements, print receipts |
| **P6** | **End Customer** | S2 (`{slug}.*`) | Guest or Registered customer account | Browse catalog, place orders, upload payment receipts, track live status |

---

## 3. End-to-End User Journeys

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │               Journey 1: Tenant Onboarding                  │
                    │ Marketing -> Register -> Admin Approval -> Dashboard Setup  │
                    └──────────────────────────────┬──────────────────────────────┘
                                                   │
     ┌─────────────────────────────────────────────┴─────────────────────────────────────────────┐
     ▼                                                                                           ▼
┌───────────────────────────────────────────┐                               ┌───────────────────────────────────────────┐
│        Journey 2: Online Ordering         │                               │          Journey 3: POS In-Store          │
│ Customer Storefront -> Pay -> Kitchen Ops │                               │ Device Pair -> Shift Float -> Sales -> Z  │
└─────────────────────┬─────────────────────┘                               └─────────────────────┬─────────────────────┘
                      │                                                                           │
                      └─────────────────────────────┬─────────────────────────────────────────────┘
                                                    ▼
                                    ┌───────────────────────────────┐
                                    │      Journey 4: Inventory     │
                                    │ Recipe Deduction -> Alert-> PO│
                                    └───────────────────────────────┘
```

---

### Journey 1: Tenant Registration, Admin Approval & Onboarding
**Primary Surfaces:** Marketing (`S1`) $\rightarrow$ Dashboard (`S3`) $\rightarrow$ Admin Console (`S4`)

1. **Visitor** lands on `www.serveos.tech`, explores vertical solutions, and clicks **"Start Free Trial"**.
2. **Visitor** is routed to `app.serveos.tech/register`, provides Business Name (`Bella Napoli`), unique slug (`bellanapoli`), vertical (`restaurant`), email, and password.
3. Upon registration, tenant status is set to `pending_approval`.
4. **Tenant Owner** attempts to log in to `app.serveos.tech`; the system displays an informative "Account Pending Admin Approval" screen preventing unauthorized dashboard operations.
5. **Platform Super Admin** logs into `admin.serveos.tech/admin/approvals`, reviews the pending application, and clicks **"Approve"** (approval activates the tenant; plan management is separate).
6. **Tenant Owner** refreshes/logs in:
   - Guided onboarding checklist launches (Setup Branch $\rightarrow$ Add Bank/Payment Account $\rightarrow$ Create First Category & Products $\rightarrow$ Generate POS Pairing Code).
7. Tenant storefront (`bellanapoli.serveos.tech`) becomes reachable publicly.

---

### Journey 2: Customer Ordering, Offline Payment & Kitchen Fulfillment
**Primary Surfaces:** Customer Storefront (`S2`) $\rightarrow$ Merchant Dashboard (`S3`)

1. **Customer** opens `roma.serveos.tech` on mobile/desktop browser.
2. **Customer** browses categories, selects "Artisan Pizza", configures required modifier group (*Crust: Thin Crust*), optional add-on (*Extra Cheese +15 EGP*), and adds to cart.
3. Cart calculates line items, modifier additions, delivery fee, and taxes using unified money math (`src/lib/order-totals.ts`).
4. **Customer** proceeds to Checkout, enters contact info, chooses **"Instapay / Bank Transfer"** (Offline Payment), and submits order.
5. Storefront displays payment instructions and account details with a file upload widget.
6. **Customer** uploads transfer screenshot; order enters `pending_verification` status.
7. **Merchant Staff** on `app.serveos.tech/dashboard/orders` receives real-time order alert.
8. Staff opens order details, inspects payment attachment, clicks **"Verify Payment"** $\rightarrow$ Order changes to `ACCEPTED`.
9. Kitchen updates order to `PREPARING` $\rightarrow$ `READY_FOR_PICKUP` $\rightarrow$ `COMPLETED`.
10. Customer's order tracking page dynamically reflects status transitions in real time.

---

### Journey 3: In-Store POS Register, Shift Management & Cash Reconciliation
**Primary Surfaces:** Merchant Dashboard (`S3`) $\rightarrow$ Electron POS Desktop App (`S5`)

1. **Manager** opens `app.serveos.tech/dashboard/settings/pos-devices` and clicks **"Mint Pairing Code"**.
2. **Cashier** launches Electron POS desktop app (`apps/pos`). First screen prompts for Tenant Slug and Pairing Code (or Owner login).
3. POS pairs with server; securely stores minted device Bearer token in encrypted local storage.
4. **Cashier** signs in using Cashier PIN/Code (`X-POS-Cashier`).
5. Prompt appears: **"Open New Shift"**. Cashier enters counted starting float (e.g. `500.00 EGP`).
6. Shift status becomes `OPEN`. POS renders quick-order product grid and category filters.
7. **Ringing Sale:**
   - Cashier taps "Burger Combo", customizes drink option, applies a 10% manager-approved discount with reason code `VIP_CUSTOMER`.
   - Customer pays split: `50.00 EGP` in Cash, remaining `70.00 EGP` via Card.
   - POS records sale via `/api/pos/v1/sales`, creates `order_payments` records, prints receipt, and triggers cash drawer kick.
8. **Cash Drop:** During the shift, cashier records a cash drop of `1,000.00 EGP` to safe (`cash_movements: DROP`).
9. **Shift Close:**
   - At shift end, cashier initiates "End Shift".
   - System prompts for blind cash count. Cashier enters `1,480.00 EGP`.
   - POS computes variance (Expected vs. Actual) and generates **Z-Report**.
   - Shift closes and locks; summary syncs to Dashboard Financial Analytics.

---

### Journey 4: Inventory Recipes (BOM), Auto-Deduction & Purchasing
**Primary Surfaces:** Merchant Dashboard (`S3`) $\rightarrow$ Electron POS (`S5`) / Storefront (`S2`)

1. **Manager** creates raw inventory items: *Flour (kg)*, *Mozzarella (kg)*, *Tomato Sauce (L)*.
2. Manager links inventory to catalog dish "Margherita Pizza" with Bill of Materials (BOM):
   - $0.20\text{ kg}$ Flour, $0.15\text{ kg}$ Mozzarella, $0.10\text{ L}$ Tomato Sauce per dish.
3. Manager sets low-stock reorder threshold for Mozzarella at $5.00\text{ kg}$.
4. High volume of sales occur through Storefront and POS.
5. Background stock ledger decrements raw ingredient quantities FIFO on every completed order.
6. Mozzarella stock drops to $4.20\text{ kg}$; system triggers dashboard notification: **"Low Stock Alert: Mozzarella"**.
7. Manager navigates to `/dashboard/purchase-orders`, clicks **"Generate PO"** for supplier "Dairy Fresh Ltd".
8. PO is created with 20 kg Mozzarella, approved, and status marked `SENT`.
9. When goods arrive, manager opens PO, clicks **"Receive Shipment"**, verifies quantities, records lot batch number and expiry date.
10. Inventory ledger increments automatically with new lot cost basis.

---

### Journey 5: Multi-Vertical Adaptation
**Primary Surfaces:** Storefront (`S2`) & Dashboard (`S3`)

* **Restaurant Vertical:** Tables, seat-level ordering, kitchen display, modifiers (cooking temps, sides, allergies).
* **Retail Vertical:** Barcode SKU scanning, color/size matrix variants, inventory by finished goods, shelf locations.
* **Pharmacy Vertical:** Prescription upload requirement for Rx products, pharmacist approval queue, dosage and batch validation.
* **Timber / Trade Vertical:** Dimensional calculators ($L \times W \times Thickness$), square/cubic meter pricing conversions, fractional quantity handling.

---

### Journey 6: Multi-Tenant Data Isolation (RLS) & Tamper-Evident Audit
**Primary Surfaces:** All Surfaces & API (`S6`)

1. **RLS Guarantee:** Database connection executes under `NOBYPASSRLS` role wrapped with `withTenant(tenantId)`.
2. **Cross-Tenant Attack Simulation:** Authenticated user of `roma` attempts direct HTTP `GET /api/orders/[id]` where `id` belongs to `bellanapoli`.
3. System returns `404 Not Found` or `403 Forbidden`, preventing any cross-tenant data leakage.
4. **Audit Integrity:** Critical mutations (e.g. price change, refund, manual inventory adjustment, role change) generate an append-only row in `audit_events` containing `{prev_hash, entry_hash, device_id, user_agent, actor_id}`.
5. System audit verification tool validates the unbroken cryptographic hash chain.

---

### Journey 7: Offline Resilience, PWA Caching & Localization (AR/EN)
**Primary Surfaces:** Storefront PWA (`S2`), Marketing (`S1`), Electron POS (`S5`)

1. **PWA Installation:** Customer opens storefront on mobile Safari/Chrome; native "Install App" banner offers home-screen install with branded manifest and icons.
2. **POS Network Interruption:** Internet connection drops mid-shift.
3. Cashier continues ringing cash sales; transactions are appended to local encrypted SQLite / IndexedDB buffer.
4. Internet reconnects; POS background queue posts buffered sales via idempotent `/api/pos/v1/sales` calls using cached device receipt UUIDs (`pos_order_receipts`). No duplicates created.
5. **Localization:** User toggles language to **Arabic (`/ar`)**:
   - Layout automatically flips to right-to-left (`dir="rtl"`).
   - Font family switches to Cairo / Arabic typography.
   - Prices and currencies display localized formatting.

---

## 4. Master Test Scenario Catalog

### 4.1 Onboarding & Authentication (`TC-AUTH`)

| Test ID | Surface | Persona | Scenario Title | Preconditions | Action Steps | Expected Outcome | Verification Tier |
|---|---|---|---|---|---|---|---|
| `TC-AUTH-001` | `S3` | Anonymous | Tenant Registration Validations | Unique email & slug available | 1. Go to `/register`.<br>2. Submit invalid email, short password.<br>3. Submit already taken slug (`roma`).<br>4. Submit valid unique details. | Invalid inputs show inline errors; duplicate slug is rejected; valid submission creates tenant in `pending_approval` state. | Playwright (`onboarding.spec.ts`) |
| `TC-AUTH-002` | `S3` | Owner | Unapproved Tenant Login Lockout | Tenant registered, status `pending_approval` | 1. Navigate to `/login`.<br>2. Enter credentials of unapproved tenant. | User is authenticated but redirected to `/pending-approval` explanation page; cannot reach dashboard. | Playwright |
| `TC-AUTH-003` | `S3` | Owner / Staff | Role-Based Access Control (RBAC) Redirection | Active tenant with Owner, Manager, Staff users | 1. Log in as `staff@roma.com`.<br>2. Attempt navigation to `/dashboard/settings` and `/dashboard/analytics`. | Staff is blocked with 403 Forbidden or redirected to allowed `/dashboard/orders` page. | Playwright (`dashboard.spec.ts`) |
| `TC-AUTH-004` | `S3` | All | Session Logout & Invalidation | Active authenticated session | 1. Click "Sign Out".<br>2. Use browser back button.<br>3. Attempt to fetch protected API route. | Session cookie cleared; redirected to login; API returns 401 Unauthorized. | Playwright (`dashboard.spec.ts`) |

---

### 4.2 Storefront PWA Customer Experience (`TC-STORE`)

| Test ID | Surface | Persona | Scenario Title | Preconditions | Action Steps | Expected Outcome | Verification Tier |
|---|---|---|---|---|---|---|---|
| `TC-STORE-001` | `S2` | Customer | Product Catalog & Category Filter | Tenant has published products in multiple categories | 1. Visit `{slug}.serveos.localhost:3000`.<br>2. Click different category tabs.<br>3. Search for product name. | Products filter instantaneously without layout shifts; search query highlights matching items. | Playwright (`shop.spec.ts`) |
| `TC-STORE-002` | `S2` | Customer | Required & Optional Modifier Selection | Product has required modifier group (e.g. Size) and optional add-ons | 1. Open product modal.<br>2. Attempt to add to cart without selecting required modifier.<br>3. Select required modifier + 2 add-ons.<br>4. Add to cart. | "Add to Cart" button is disabled or warns until required selection is made; cart reflects base price + modifier additions. | Playwright (`ordering.spec.ts`) |
| `TC-STORE-003` | `S2` | Customer | Out-of-Stock Item Restriction | Product stock is 0 and `stockTracking = true` | 1. Navigate to product card.<br>2. Attempt to click or add to cart. | Item displays "Out of Stock" badge; button is disabled; cannot be added to cart. | Playwright (`shop.spec.ts`) |
| `TC-STORE-004` | `S2` | Customer | Offline Payment & Receipt Attachment Flow | Tenant enabled Instapay / Bank Transfer in settings | 1. Proceed to Checkout.<br>2. Select Offline Payment.<br>3. Submit order.<br>4. Upload image file on receipt submission screen. | Order created as `pending_verification`; receipt image uploaded to Supabase storage and linked to order record. | Playwright (`offline-payment.spec.ts`) |
| `TC-STORE-005` | `S2` | Customer | Order Scheduling (Date & Time Picker) | Tenant allows scheduled orders | 1. On checkout, toggle "Schedule for Later".<br>2. Select tomorrow at 18:00.<br>3. Complete order. | Order created with `scheduled_for` timestamp; visible in dashboard scheduled orders tab. | Playwright (`scheduling.spec.ts`) |
| `TC-STORE-006` | `S2` | Customer | Order Cancellation while Pending | Customer placed order with status `PENDING` | 1. Open order tracking page.<br>2. Click "Cancel Order".<br>3. Confirm cancellation. | Order status updates to `CANCELLED`; kitchen alert revoked; customer tracking shows cancellation. | Playwright (`scheduling.spec.ts`) |

---

### 4.3 Merchant Dashboard Operations (`TC-DASH`)

| Test ID | Surface | Persona | Scenario Title | Preconditions | Action Steps | Expected Outcome | Verification Tier |
|---|---|---|---|---|---|---|---|
| `TC-DASH-001` | `S3` | Staff | Live Order Status State Transitions | New order in `PENDING` state | 1. Open `/dashboard/orders`.<br>2. Click "Accept Order".<br>3. Click "Start Preparing".<br>4. Click "Ready for Pickup".<br>5. Click "Complete". | Status transitions sequentially: `PENDING` $\rightarrow$ `ACCEPTED` $\rightarrow$ `PREPARING` $\rightarrow$ `READY` $\rightarrow$ `COMPLETED`. Database and UI sync. | Playwright / Vitest |
| `TC-DASH-002` | `S3` | Manager | Offline Payment Verification & Rejection | Order with status `pending_verification` and uploaded proof | 1. Open `/dashboard/payments`.<br>2. Click to preview uploaded receipt.<br>3. Click "Verify & Confirm Payment". | Order status becomes `PAID` / `ACCEPTED`; payment marked verified with manager's user ID timestamped. | Playwright (`offline-payment.spec.ts`) |
| `TC-DASH-003` | `S3` | Manager | Menu Category & Product CRUD | Manager authenticated | 1. Create Category "Desserts".<br>2. Create Product "Tiramisu" with price 80.00 EGP, image, and tax rate.<br>3. Edit price to 90.00 EGP.<br>4. Toggle "Publish". | Product persists in DB; updates instantly visible on Storefront; audit log records modification. | Playwright / Vitest |
| `TC-DASH-004` | `S3` | Manager | Recipe (BOM) Ingredient Linking | Raw inventory items exist | 1. Open `/dashboard/inventory/recipes`.<br>2. Select "Margherita Pizza".<br>3. Add 0.2 kg Flour, 0.15 kg Cheese.<br>4. Save Recipe. | BOM link is stored in `product_inventory_links`; inventory deduction engine activates for this product. | Vitest Integration |
| `TC-DASH-005` | `S3` | Manager | Purchase Order Lifecycle & Goods Receiving | Supplier configured in directory | 1. Create PO for Supplier "Dairy Fresh" with 20 kg Cheese @ 100 EGP/kg.<br>2. Submit PO.<br>3. Click "Receive Goods", enter batch/lot number and expiry date.<br>4. Confirm receipt. | PO marked `RECEIVED`; inventory stock increments by 20 kg; lot entry created with cost basis. | Playwright / Vitest |
| `TC-DASH-006` | `S3` | Owner | POS Device Pairing Code Generation | Owner on Settings page | 1. Navigate to `/dashboard/settings/pos-devices`.<br>2. Select Branch "Main".<br>3. Click "Generate Pairing Code". | 8-character uppercase alphanumeric code generated with 10-minute expiration; stored in DB. | Playwright / Vitest |
| `TC-DASH-007` | `S3` | Manager | Cross-Channel Financial Analytics & Reports | Tenant plan has `advanced_analytics = true` | 1. Open `/dashboard/analytics`.<br>2. Filter date range (Today, This Week, Custom).<br>3. Inspect Gross Sales, Net Sales, Tax Breakdown, Channel Split. | Metrics accurately aggregate POS + Storefront orders; non-entitled tenants are gated with plan upgrade banner. | Vitest / Playwright |

---

### 4.4 Electron POS Desktop App (`TC-POS`)

| Test ID | Surface | Persona | Scenario Title | Preconditions | Action Steps | Expected Outcome | Verification Tier |
|---|---|---|---|---|---|---|---|
| `TC-POS-001` | `S5` | Cashier | First-Time Device Pairing via Code | Fresh Electron app launch; valid pairing code from dashboard | 1. Launch `apps/pos`.<br>2. Enter tenant slug `roma` and pairing code.<br>3. Click "Pair Device". | Device exchanges code for permanent device bearer token; stores credentials securely; navigates to Cashier Login. | Vitest (`apps/pos`) / Manual |
| `TC-POS-002` | `S5` | Cashier | Shift Open & Starting Cash Float | Paired device; no active open shift | 1. Enter Cashier PIN.<br>2. On "Open Shift" prompt, input `500.00 EGP` float.<br>3. Click "Open Register". | Shift record created in `pos_shifts` with status `OPEN`; cash drawer opening balance set to 500.00 EGP. | Vitest / Manual |
| `TC-POS-003` | `S5` | Cashier | Ring Sale with Split Tender (Cash + Card) | Shift is `OPEN` | 1. Add items to cart (Total: 120.00 EGP).<br>2. Click Pay $\rightarrow$ Select Split Tender.<br>3. Input Cash: `50.00 EGP`, Card: `70.00 EGP`.<br>4. Complete Sale. | Sale recorded via `/api/pos/v1/sales`; 2 payment records created; receipt printed; cash drawer balance increases by 50.00 EGP. | Vitest / Manual |
| `TC-POS-004` | `S5` | Cashier | Line Item Void & Discount with Reason Code | Items in active till cart | 1. Apply 10% discount to item $\rightarrow$ select reason `PROMO`.<br>2. Void line item $\rightarrow$ select reason `CUSTOMER_CHANGED_MIND`.<br>3. Complete order. | Adjustments recorded in `pos_adjustment_events`; totals recalculated correctly; audit event emitted. | Vitest / Manual |
| `TC-POS-005` | `S5` | Cashier | Cash Drawer Movement (Pay-In / Pay-Out / Drop) | Shift is `OPEN` | 1. Open Drawer Menu $\rightarrow$ Select "Cash Drop".<br>2. Enter amount `1,000.00 EGP` and note "Midday Drop to Safe".<br>3. Submit. | Record added to `cash_movements`; expected drawer cash decreases by 1,000.00 EGP; drawer kicks. | Vitest / Manual |
| `TC-POS-006` | `S5` | Cashier | Shift Close, Blind Count & Z-Report | Shift is `OPEN` with sales and movements | 1. Click "Close Shift".<br>2. Enter counted cash `1,450.00 EGP`.<br>3. Submit.<br>4. Print Z-Report. | Shift closed; variance calculated (Counted vs. Expected); Z-Report summarizes totals, tender breakdown, taxes, voids; shift locked. | Vitest / Manual |
| `TC-POS-007` | `S5` | Cashier | Offline Sales Buffering & Background Sync | Shift is `OPEN`; network connection disabled | 1. Disconnect network.<br>2. Ring 2 cash sales.<br>3. Re-enable network connection. | Sales are saved locally without error; once online, sync daemon pushes orders with cached UUIDs; no duplicate records created. | Vitest / Manual |

---

### 4.5 Platform Admin Console (`TC-ADMIN`)

| Test ID | Surface | Persona | Scenario Title | Preconditions | Action Steps | Expected Outcome | Verification Tier |
|---|---|---|---|---|---|---|---|
| `TC-ADMIN-001` | `S4` | Super Admin | Super Admin Authentication & MFA | Platform Admin account | 1. Navigate to `admin.serveos.localhost:3000/admin/login`.<br>2. Log in with `admin@serveos.com`. | Reaches Admin Console; non-admin users attempting access receive 403 Forbidden with clear reason. | Playwright (`admin.spec.ts`) |
| `TC-ADMIN-002` | `S4` | Super Admin | Tenant Review & Approval Workflow | Tenant in `pending_approval` status | 1. Open `/admin/approvals`.<br>2. Find the pending tenant.<br>3. Review details, click "Approve". | Tenant status becomes `ACTIVE`; tenant owner can now access full dashboard; storefront goes live. | Playwright (`admin.spec.ts`) |
| `TC-ADMIN-003` | `S4` | Super Admin | Plan Entitlement Override & Feature Gating | Active tenant on `STARTER` plan | 1. Open Tenant Details.<br>2. Override entitlement `advanced_analytics: true`.<br>3. Save. | Tenant immediately gains access to Analytics without full plan upgrade; change logged in platform audit. | Vitest / Playwright |
| `TC-ADMIN-004` | `S4` | Super Admin | Tenant Suspension & Re-activation | Active tenant | 1. Click "Suspend Tenant" with reason "Billing Overdue".<br>2. Attempt to access tenant Storefront and Dashboard.<br>3. Click "Reactivate Tenant". | While suspended, Storefront shows maintenance/suspended page; dashboard blocked; reactivating restores full functionality. | Vitest / Playwright |

---

### 4.6 Security, RLS & Audit Integrity (`TC-SEC`)

| Test ID | Surface | Persona | Scenario Title | Preconditions | Action Steps | Expected Outcome | Verification Tier |
|---|---|---|---|---|---|---|---|
| `TC-SEC-001` | `S6` | Attacker | Cross-Tenant Direct Object Reference (RLS Isolation) | Two active tenants (`roma`, `milan`) | 1. Authenticate as `roma` user.<br>2. Execute API request `GET /api/orders/{milan_order_id}`.<br>3. Execute `POST /api/products` attempting to insert `tenant_id = milan`. | `withTenant` wrapper and PostgreSQL FORCE RLS enforce strict isolation: returns `404 Not Found` or `403`; cross-tenant write fails. | Vitest DB Integration |
| `TC-SEC-002` | `S6` | System | Hash-Chained Audit Log Tamper Evidence | Audit trail exists with sequential hashes | 1. Query `audit_events` for tenant.<br>2. Verify each row `prev_hash` matches previous row `entry_hash`.<br>3. Simulate database row modification. | Verification algorithm detects hash mismatch immediately if any row or sequence is altered. | Vitest Integration |
| `TC-SEC-003` | `S6` | System | Host Header Spoofing Prevention | Storefront request | 1. Send HTTP request to `app.serveos.localhost` with header `x-tenant-slug: roma`. | Middleware (`src/proxy.ts`) strips spoofed `x-tenant-slug` on non-storefront hosts; rejects invalid routing. | Playwright (`onboarding.spec.ts`) |

---

### 4.7 Internationalization, RTL & Responsiveness (`TC-I18N`)

| Test ID | Surface | Persona | Scenario Title | Preconditions | Action Steps | Expected Outcome | Verification Tier |
|---|---|---|---|---|---|---|---|
| `TC-I18N-001` | `S1`, `S2` | Customer | Arabic RTL Layout & Font Rendering | Marketing or Storefront page | 1. Switch language toggle to Arabic (`/ar`).<br>2. Inspect DOM `dir="rtl"`, alignments, and fonts. | Layout mirrors correctly to RTL; Cairo font applies; no horizontal scrollbar overflow occurs. | Playwright (`marketing.spec.ts`) |
| `TC-I18N-002` | `S2`, `S3` | All | Mobile Viewport Tap Targets & Inputs | Viewport set to 375px (iPhone SE / Mobile) | 1. Open mobile navigation drawer.<br>2. Tap buttons, form fields, and dropdowns. | All tap targets are $\ge 40\text{px}$; inputs do not cause auto-zoom on iOS (`font-size \ge 16px`); cards stack vertically. | Playwright (`responsive.spec.ts`) |

---

## 5. Test Automation Coverage & Gap Analysis

Based on the [Feature Maturity Audit](../ailab/references/2026-08-13-feature-maturity-audit.md), the table below highlights current automated coverage vs. manual QA requirements:

| Domain / Surface | Existing Automated Coverage | Coverage State | Action Required for Issue #142 |
|---|---|---|---|
| **Marketing Site (`S1`)** | `tests/e2e/marketing.spec.ts` (11 tests) | **Proven (Tier A)** | Maintain regression suite |
| **Auth & Dashboard (`S3`)** | `tests/e2e/dashboard.spec.ts`, `responsive.spec.ts` | **Proven (Tier A)** | Add tests for inventory & PO screens |
| **Offline Payments (`S2` $\rightarrow$ `S3`)** | `tests/e2e/offline-payment.spec.ts` | **Proven (Tier A)** | Gold standard cross-surface test |
| **Admin Console (`S4`)** | `tests/e2e/admin.spec.ts` | **Proven (Tier A)** | Add tenant approval action test |
| **Storefront PWA (`S2`)** | `ordering.spec.ts`, `shop.spec.ts`, `scheduling.spec.ts` | **Proven (Tier A)** | Add modifier edge-case tests |
| **Electron POS (`S5`)** | Vitest unit tests only (`apps/pos`); **0 E2E tests** | **Unproven (Tier B)** | **Priority:** Author Playwright-Electron / mock E2E suite for shift & sales lifecycle |
| **Inventory & Recipes (`S3`)** | Vitest API tests (`src/server/inventory/`); **0 E2E** | **Unproven (Tier B)** | **Priority:** Write journey tests for BOM auto-deduction and PO receiving |
| **Pharmacy Prescriptions (`S2`/`S3`)**| Domain unit tests; **0 E2E** | **Unproven (Tier B)** | Write Rx upload $\rightarrow$ verification test |

---

## 6. QA Execution Runbook

### 6.1 Local Environment QA Run
To execute the existing automated test suites locally:

```bash
# 1. Start Local Postgres & run migrations
npm run db:migrate:test

# 2. Run Backend Unit & Integration Tests (Vitest)
npm run test

# 3. Run POS Suite
npm run pos:test

# 4. Run Playwright End-to-End Suite (requires seeded dev DB)
npm run db:seed
npm run test:e2e
```

### 6.2 Staging / QA Environment Smoke Checklist (`qa.serveos.tech`)
Perform this manual verification drill after each deploy to `qa` branch:
1. **Marketing Check:** Open `qa.serveos.tech` $\rightarrow$ verify Arabic (`/ar`) and English (`/en`) pricing cards.
2. **Admin Check:** Log in to `admin.qa.serveos.tech` with admin credentials $\rightarrow$ check system metrics.
3. **Storefront Order Check:** Open `roma.qa.serveos.tech` $\rightarrow$ place test order with offline payment $\rightarrow$ upload test slip.
4. **Merchant Fulfillment:** Log in to `app.qa.serveos.tech` $\rightarrow$ accept test order $\rightarrow$ verify order transitions to `COMPLETED`.
5. **POS Connection:** Launch test POS configured against `qa.serveos.tech` $\rightarrow$ pair with fresh code $\rightarrow$ ring 1 test sale.
