# ServeOS QA: Tester Playbook, Expected Results & Focus Guide

**Document ID:** QA-PLAYBOOK-001  
**Audience:** QA Engineers, Product Testers, Developers new to ServeOS  
**Date:** 2026-08-18  
**Repository Branch:** `docs/142-qa-user-journeys`  
**Related Specs & PRDs:** [PRD-001 (Master PRD)](../prds/prd-high-serveos.md), [Roadmap](../ROADMAP.md), [QA Specification](2026-08-18-user-journeys-and-test-scenarios.md)

---

## Table of Contents
1. [Core Mental Model: How ServeOS Actually Works](#1-core-mental-model-how-serveos-actually-works)
2. [The Three Golden Rules of Testing ServeOS](#2-the-three-golden-rules-of-testing-serveos)
3. [Deep-Dive Journey Guide (Steps, Expected Results & Edge Cases)](#3-deep-dive-journey-guide)
   - [Journey 1: Tenant Registration, Approval & Store Onboarding](#journey-1-tenant-registration-approval--store-onboarding)
   - [Journey 2: Online Ordering, Offline Proof & Kitchen Fulfillment](#journey-2-online-ordering-offline-proof--kitchen-fulfillment)
   - [Journey 3: In-Store POS Register, Shift Management & Cash Reconciliation](#journey-3-in-store-pos-register-shift-management--cash-reconciliation)
   - [Journey 4: Inventory BOM (Recipes), Auto-Deduction & Purchasing](#journey-4-inventory-bom-recipes-auto-deduction--purchasing)
   - [Journey 5: Multi-Vertical Adaptations (Restaurant, Retail, Pharmacy, Timber)](#journey-5-multi-vertical-adaptations)
   - [Journey 6: Multi-Tenant Data Isolation (RLS) & Tamper-Evident Audit](#journey-6-multi-tenant-data-isolation-rls--tamper-evident-audit)
   - [Journey 7: Offline Resilience, PWA Caching & Localization (AR/EN)](#journey-7-offline-resilience-pwa-caching--localization-aren)
4. [Vertical-Specific Testing Matrix](#4-vertical-specific-testing-matrix)
5. [Behind-the-Scenes Verification Guide (Database & Network)](#5-behind-the-scenes-verification-guide)
6. [Top 10 Bug Hotspots in ServeOS (Where Things Usually Break)](#6-top-10-bug-hotspots-in-serveos)

---

## 1. Core Mental Model: How ServeOS Actually Works

Before clicking any buttons, keep this mental model in mind:

```
                                  Platform Admin Console
                                  (admin.serveos.localhost:3000)
                                            │
               ┌────────────────────────────┼────────────────────────────┐
               ▼                            ▼                            ▼
      Customer Storefront (PWA)     Merchant Dashboard             Electron Desktop POS
      (roma.serveos.localhost:3000) (app.serveos.localhost:3000)  (apps/pos desktop app)
               │                            │                            │
               │                            │                            │
               └───────────────────────┬────┴────────────────────────────┘
                                       ▼
                         PostgreSQL Database + FORCE RLS
                         - One shared schema for all tenants
                         - Strict Row-Level Security isolation
                         - Unified Order & Inventory models
```

1. **One Database, Many Hosts:**  
   The platform routes requests based on the domain hostname (`src/proxy.ts`). 
   - `admin.*` loads the Super Admin panel.
   - `app.*` loads the Merchant Operations Dashboard.
   - `roma.*` loads the customer storefront for the tenant slug `roma`.
   - `apps/pos` is a desktop Electron app that connects to `/api/pos/v1/*`.
2. **A Sale is a Sale:**  
   Whether an order is placed on a smartphone via the storefront or rung up at a physical counter via the Electron POS, it writes to the **same** `orders` table and uses the exact same money calculation engine (`src/lib/order-totals.ts`).

---

## 2. The Three Golden Rules of Testing ServeOS

### Rule #1: Test Reachability, Not Just Endpoints
> *The WhatsApp Bug Lesson:* In past sprints, WhatsApp ordering had 77 passing unit tests, but real customers couldn't place an order because the catalog entry button was never rendered in the UI.  
**Your Bar as QA:** Always verify the full, clickable user journey from a cold start to the final screen using only what the UI displays.

### Rule #2: Watch Out for Floating-Point Money Math
All monetary values in ServeOS are stored as exact decimal strings via `money(n)` (e.g. `"145.50"`).
**What to focus on:** When testing discounts, tax rates ($14\%$ VAT in Egypt), tips, or split payments, verify that numbers NEVER produce rounding artifacts like `145.50000000000003` or off-by-one piastre ($0.01\text{ EGP}$) variances.

### Rule #3: Never Assume Cross-Tenant Safety
Because all tenants share one database, PostgreSQL Row-Level Security (RLS) protects tenant data.
**What to focus on:** As you test, always check if Tenant A (`roma`) can accidentally see, search, or access records belonging to Tenant B (`bellanapoli`).

---

## 3. Deep-Dive Journey Guide

---

### Journey 1: Tenant Registration, Approval & Store Onboarding

#### What This Journey Is
The onboarding pipeline from a stranger visiting the marketing site, registering a business, waiting for platform admin approval, to configuring their store for the first time.

#### Test Execution Steps
1. Open `http://serveos.localhost:3000` $\rightarrow$ Click **"Start Free Trial"** (routes to `/register`).
2. Fill out registration:
   - Business Name: `Cairo Roasters`
   - Slug: `cairoroasters`
   - Vertical: `restaurant`
   - Email: `owner@cairoroasters.com`
   - Password: `Password123!`
3. Submit form.
4. Try logging in immediately at `http://app.serveos.localhost:3000/login`.
5. Open `http://admin.serveos.localhost:3000/admin/login` $\rightarrow$ Sign in as `admin@serveos.com` / `admin1234`.
6. Navigate to `/admin/approvals` $\rightarrow$ Find `cairoroasters` in the pending list $\rightarrow$ Click **"Approve"**. (Tenant detail pages under `/admin/tenants` manage already-active tenants; approval has no plan-selection step.)
7. Go back to `http://app.serveos.localhost:3000/login` $\rightarrow$ Sign in as `owner@cairoroasters.com`.
8. Complete the guided setup:
   - Create Main Branch.
   - Add Bank / Instapay details in Settings.
   - Add a Category & 1 Product.
   - Check public storefront at `http://cairoroasters.serveos.localhost:3000`.

#### Exact Expected Results
* **Before Approval:** Logging in displays a clear message: *"Your account is currently under review by our team"*. No dashboard menus are accessible.
* **Admin Action:** Approving the tenant sets `tenants.status = 'active'`, marks the onboarding application approved, and writes a `tenant.approved` audit entry.
* **After Approval:** Owner logs in directly to the Onboarding Hub/Dashboard.
* **Storefront Activation:** `http://cairoroasters.serveos.localhost:3000` responds with the tenant's brand name, theme, and published products.

#### What to Focus on & Edge Cases
* 🔍 **Duplicate Slugs:** Try registering with the existing slug `roma` $\rightarrow$ UI must show instant inline error *"This store URL is already taken"*.
* 🔍 **Special Characters in Slug:** Test uppercase letters, spaces, or symbols (e.g. `Cairo Roasters!`) $\rightarrow$ Slug field should auto-sanitize to `cairo-roasters` or reject invalid characters.
* 🔍 **Suspended Tenant Behavior:** In Admin panel, click "Suspend Tenant". Try opening the storefront $\rightarrow$ Must display a polite maintenance/suspension notice without crashing.

---

### Journey 2: Online Ordering, Offline Proof & Kitchen Fulfillment

#### What This Journey Is
The primary customer-to-kitchen flow. A customer visits the mobile/web storefront, customizes an order with modifiers, checks out using Instapay/bank transfer, uploads a screenshot of the payment slip, and the merchant verifies and prepares the order.

#### Test Execution Steps
1. Open `http://roma.serveos.localhost:3000`.
2. Select a product with modifiers (e.g., "Artisan Pizza" with required *Crust* and optional *Extra Toppings*).
3. Try clicking "Add to Cart" without picking the required modifier.
4. Select *Thin Crust* + *Extra Cheese (+15.00 EGP)* $\rightarrow$ Add to Cart.
5. Go to Checkout:
   - Fill in Customer Name: `Sarah Ahmed`, Phone: `01012345678`, Address: `12 Zamalek St`.
   - Select Payment Method: **"Instapay / Bank Transfer"**.
   - Place Order.
6. On the confirmation screen, view the merchant's Instapay username/bank details.
7. Click the file upload input $\rightarrow$ attach a receipt image (`.jpg` or `.png`).
8. Open `http://app.serveos.localhost:3000/login` in another window $\rightarrow$ Sign in as `staff@roma.com` / `staff1234`.
9. Go to `/dashboard/orders` $\rightarrow$ Open the new order.
10. Click the attached receipt preview $\rightarrow$ Click **"Verify Payment"**.
11. Progress status: **"Start Preparing"** $\rightarrow$ **"Mark Ready"** $\rightarrow$ **"Complete"**.
12. Check customer tracking page.

#### Exact Expected Results
* **Cart Calculations:** Base Price ($100.00$) + Modifier ($+15.00$) + Delivery Fee ($20.00$) + VAT ($14\%$) must sum exactly to the cent.
* **Order Status:** Initial state is `pending_verification` (or `pending`).
* **Payment Attachment:** Receipt image uploads cleanly to Supabase storage; thumbnail is clickable in the merchant dashboard with full-size preview modal.
* **Verification:** Verifying payment updates status to `confirmed` / `accepted` and stamps the verifying manager's User ID.
* **Live Customer Tracking:** Customer order status page updates from *"Order Placed"* $\rightarrow$ *"Payment Verified"* $\rightarrow$ *"Preparing in Kitchen"* $\rightarrow$ *"Ready for Pickup/Delivered"*.

#### What to Focus on & Edge Cases
* 🔍 **Modifier Limits:** If a modifier group specifies `maxSelections: 2`, try selecting 3 $\rightarrow$ 3rd checkbox must be disabled.
* 🔍 **Invalid File Upload:** Upload a `.txt` or `.exe` file as receipt proof $\rightarrow$ UI must reject non-image file types with a clear warning.
* 🔍 **Out-of-Stock Products:** Set a product's stock to `0` in dashboard $\rightarrow$ Storefront card must show an "Out of Stock" chip and disable the add-to-cart button.
* 🔍 **Order Scheduling:** Toggle "Schedule for Later" $\rightarrow$ Pick tomorrow at 2:00 PM $\rightarrow$ Order must record `scheduledFor` and show under the Scheduled tab in dashboard.

---

### Journey 3: In-Store POS Register, Shift Management & Cash Reconciliation

#### What This Journey Is
The physical till flow inside the store using the desktop Electron application (`apps/pos`). This covers device pairing, cashier shifts, drawer cash tracking, ringing sales with split tenders, discounts, cash drops, and end-of-day Z-reports.

#### Test Execution Steps
1. In Dashboard (`app.serveos.localhost:3000` as Owner), go to `/dashboard/settings/pos-devices` $\rightarrow$ Click **"Mint Pairing Code"** (8 uppercase alphanumeric characters, e.g. `A7K2P9QM`; valid for 10 minutes).
2. Start the POS app:
   ```bash
   npm run pos:dev
   ```
3. Enter slug `roma` and the minted pairing code (e.g. `A7K2P9QM`) $\rightarrow$ Click **"Pair Device"**.
4. Log in as Cashier (`staff@roma.com` or cashier PIN).
5. **Open Shift Screen:** Enter starting cash float: `500.00 EGP` $\rightarrow$ Open Shift.
6. **Ring a Sale:**
   - Tap 2x Double Burgers + 1x Cola.
   - Click "Discount" $\rightarrow$ Apply $10\%$ discount with reason `HAPPY_HOUR`.
   - Click "Pay" $\rightarrow$ Choose **"Split Tender"**.
   - Cash Tender: `100.00 EGP`, Card Tender: `80.00 EGP`.
   - Complete Sale $\rightarrow$ Receipt renders on screen.
7. **Cash Movement:**
   - Open Till Drawer menu $\rightarrow$ Select **"Cash Drop"** (Safe Drop).
   - Enter `300.00 EGP`, Note: *"Transfer to safe"*. Submit.
8. **Shift Close:**
   - Click **"End Shift"**.
   - Blind Count Prompt: Count your physical cash and enter `300.00 EGP`.
   - System computes:
     $$\text{Expected} = \text{Opening Float } (500) + \text{Cash Sales } (100) - \text{Safe Drop } (300) = 300.00\text{ EGP}$$
     $$\text{Variance} = \text{Counted } (300) - \text{Expected } (300) = 0.00\text{ EGP}$$
   - Review and print **Z-Report**.

#### Exact Expected Results
* **Device Security:** Device Bearer token is saved locally; all subsequent API calls pass `X-POS-Cashier` header.
* **Active Shift Lock:** A cashier cannot ring cash sales without an active `OPEN` shift.
* **Tender Stamping:** Every tender row in `order_payments` contains the active `shiftId`.
* **Variance Calculation:** If the cashier inputs `280.00 EGP` during close, variance must show as **`-20.00 EGP (Shortage)`**. If `350.00 EGP`, variance must show **`+50.00 EGP (Overage)`**.
* **Z-Report:** Generates an immutable shift summary with total gross, net, tax, voids, discounts, tender breakdown, and variance. Once closed, the shift is locked.

#### What to Focus on & Edge Cases
* 🔍 **Simultaneous Shifts:** Try opening two shifts on the same device $\rightarrow$ Partial unique database index `UNIQUE (deviceId) WHERE status = 'open'` prevents double shifts.
* 🔍 **Manager Override on Discounts:** If a cashier tries to apply a discount $> 20\%$, verify that a manager PIN prompt appears before the discount is applied.
* 🔍 **Item Void Trail:** Add an item $\rightarrow$ Void it with reason `MISTAKE` $\rightarrow$ Verify order total recalculates and a record is created in `pos_adjustment_events`.
* 🔍 **Offline POS Mode:** Cut Wi-Fi/Internet $\rightarrow$ Ring a cash sale $\rightarrow$ Sale should succeed locally $\rightarrow$ Reconnect internet $\rightarrow$ Sale syncs with server without duplicate receipt ID.

---

### Journey 4: Inventory BOM (Recipes), Auto-Deduction & Purchasing

#### What This Journey Is
The raw ingredient and recipe management flow for restaurants. Selling a finished dish automatically calculates and deducts raw ingredient portions from the stock ledger. When ingredients run low, the manager generates and receives a Purchase Order (PO).

#### Test Execution Steps
1. Go to `/dashboard/inventory` (as Manager/Owner).
2. Create 3 raw inventory items:
   - `Flour` (Base Unit: `kg`, Reorder Point: `10 kg`, Cost: `20 EGP/kg`)
   - `Cheese` (Base Unit: `kg`, Reorder Point: `5 kg`, Cost: `150 EGP/kg`)
   - `Tomato Sauce` (Base Unit: `L`, Reorder Point: `5 L`, Cost: `40 EGP/L`)
3. Go to `/dashboard/inventory/recipes` $\rightarrow$ Link to Catalog Product **"Margherita Pizza"**:
   - Add $0.25\text{ kg}$ Flour
   - Add $0.20\text{ kg}$ Cheese
   - Add $0.10\text{ L}$ Tomato Sauce
4. Add initial stock via Manual Adjustment:
   - Flour: $10.50\text{ kg}$, Cheese: $5.40\text{ kg}$, Tomato Sauce: $10.00\text{ L}$.
5. Place and complete 3 orders of "Margherita Pizza" (via Storefront or POS).
6. Return to `/dashboard/inventory` $\rightarrow$ Inspect Cheese stock:
   $$\text{Remaining Cheese} = 5.40 - (3 \times 0.20) = 4.80\text{ kg}$$
7. Notice Cheese is now below reorder threshold ($4.80 < 5.00$).
8. Go to `/dashboard/purchase-orders` $\rightarrow$ Click **"New Purchase Order"**:
   - Supplier: `Almarai Dairy`
   - Item: Cheese, Quantity: $20\text{ kg}$, Expected Unit Cost: `150.00 EGP`.
   - Submit PO (Status $\rightarrow$ `SENT`).
9. Click **"Receive Shipment"**:
   - Enter Received Qty: $20\text{ kg}$, Lot/Batch Number: `LOT-2026-08`, Expiry Date: `2026-12-31`.
   - Confirm Receipt.
10. Check Cheese stock $\rightarrow$ Now $24.80\text{ kg}$.

#### Exact Expected Results
* **Fractional Precision:** Inventory ledger calculates fractional quantities accurately ($0.25\text{ kg}$ deducted, not rounded to $0$ or $1$).
* **FIFO Lot Allocation:** Deduction consumes older lots first based on FIFO principles.
* **Low Stock Visual Cue:** Items below their reorder point display an orange/red alert badge.
* **PO Status Workflow:** `DRAFT` $\rightarrow$ `SENT` $\rightarrow$ `PARTIALLY_RECEIVED` (if qty < ordered) $\rightarrow$ `RECEIVED`.
* **Audit Trail:** Every deduction and receipt writes an immutable line in `stock_ledger`.

#### What to Focus on & Edge Cases
* 🔍 **Kitchen Oversell Policy (`allowNegativeStock`):** In a busy restaurant kitchen, selling a pizza when cheese is at $0\text{ kg}$ should **not** block the cashier till; stock should go to $-0.20\text{ kg}$ with a critical alert. In Retail, it must strictly block (`OutOfStockError`).
* 🔍 **Partial Receiving:** Order $20\text{ kg}$, receive only $12\text{ kg}$ $\rightarrow$ PO must remain `PARTIALLY_RECEIVED` with $8\text{ kg}$ outstanding.

---

### Journey 5: Multi-Vertical Adaptations

#### What to Test for Each Vertical:

| Vertical | Key Functional Feature | Expected Behavior to Verify | Focus & Pitfalls |
|---|---|---|---|
| **Restaurant** | Modifiers & BOM Recipes | Required modifier validation; dish sales deduct raw ingredients. | Ensure table numbers and dine-in/takeaway toggles appear. |
| **Retail** | Color/Size Matrix Variants & Barcodes | Selling a "Medium Red T-Shirt" deducts only that variant's stock. | Barcode search field in POS auto-adds item on exact match. |
| **Pharmacy** | Prescription (Rx) Upload Requirement | Products flagged `requiresPrescription` cannot be checked out online without uploading an Rx slip. | Pharmacist must approve Rx in `/dashboard/prescriptions` before order can be accepted. |
| **Timber / Trade** | Dimensional Math ($L \times W \times H$) | Dimensions calculate total square/cubic meters with fractional pricing. | Verify decimals like $2.4\text{m} \times 1.2\text{m} = 2.88\text{ m}^2$ calculate total price correctly. |

---

### Journey 6: Multi-Tenant Data Isolation (RLS) & Tamper-Evident Audit

#### What This Journey Is
Validating security boundaries. A tenant must never see another tenant's records, and system mutations must generate a tamper-evident cryptographic hash chain.

#### Test Execution Steps
1. Create or identify Order `#1001` belonging to tenant `roma`.
2. Open incognito window $\rightarrow$ Sign in to `app.serveos.localhost:3000` as Owner of tenant `milan` (`owner@milan.com`).
3. Manually change browser URL to: `http://app.serveos.localhost:3000/dashboard/orders/[roma_order_id]`.
4. Check response.
5. In Admin Console (`admin.serveos.localhost:3000`), open `/admin/audit`.
6. Inspect the hash chain table: each record displays `prevHash`, `entryHash`, `actorId`, `action`, `timestamp`.

#### Exact Expected Results
* **RLS Isolation:** The URL attempt by `milan` returns **`404 Not Found`** or **`403 Forbidden`**. No customer names, phone numbers, or amounts are leaked.
* **Audit Chain Integrity:** Every critical action (Order Void, Refund, User Role Change, Price Edit, Stock Adjustment) writes a row with:
  $$\text{entryHash} = \text{SHA-256}(\text{prevHash} + \text{payload} + \text{timestamp} + \text{actorId})$$
* **Chain Continuity:** Row $N$'s `prevHash` equals Row $N-1$'s `entryHash`.

---

### Journey 7: Offline Resilience, PWA Caching & Localization (AR/EN)

#### What This Journey Is
Testing network dropouts, progressive web app installation, and Arabic-first right-to-left (RTL) localization.

#### Test Execution Steps
1. Open Storefront (`http://roma.serveos.localhost:3000`) on a mobile browser or Chrome DevTools (Mobile Viewport).
2. Check browser address bar for the **"Install App"** icon/prompt.
3. Switch language toggle to **العربية (`/ar`)**:
   - Inspect page layout, fonts, and form alignment.
4. On POS app (`apps/pos`), disconnect your network connection.
5. Ring 2 cash sales.
6. Reconnect network.

#### Exact Expected Results
* **PWA Manifest:** App displays custom tenant icon, splash screen, and theme color from database.
* **Arabic RTL:**
  - HTML tag has `dir="rtl"` and `lang="ar"`.
  - Layout flips naturally: Sidebar is on the right, text is right-aligned.
  - Arabic typography (Cairo font) renders cleanly without clipped glyphs.
  - No horizontal scrollbars appear on mobile screens ($375\text{px}$ width).
* **Offline POS Sync:**
  - POS shows an "Offline Mode — Changes Buffered" indicator.
  - Sales succeed locally.
  - Upon reconnection, sync daemon pushes orders using `clientPaymentId` idempotency. No duplicate orders created on server.

---

## 4. Vertical-Specific Testing Matrix

Use this quick-reference table when testing different store setups:

```
┌─────────────────┬───────────────────────────────────┬───────────────────────────────────┐
│ Vertical        │ Key Capabilities                  │ What QA Must Validate            │
├─────────────────┼───────────────────────────────────┼───────────────────────────────────┤
│ 🍕 Restaurant   │ • Modifiers (Required / Optional) │ • No checkout without required mod│
│                 │ • BOM Recipe Ingredient Deduction │ • Flour/Cheese deducted on sale   │
│                 │ • Kitchen Order Status Tracking   │ • Table / Dine-in tags present    │
├─────────────────┼───────────────────────────────────┼───────────────────────────────────┤
│ 👕 Retail       │ • Matrix Variants (Size x Color)  │ • Correct SKU stock decremented   │
│                 │ • Strict Out-of-Stock Blocking    │ • Zero-stock items cannot be sold │
│                 │ • Barcode Scanning in POS         │ • Instant match in search field   │
├─────────────────┼───────────────────────────────────┼───────────────────────────────────┤
│ 💊 Pharmacy     │ • Prescription (Rx) Mandatory Gate│ • Rx upload required on checkout  │
│                 │ • Pharmacist Approval Queue       │ • Pharmacist approval before fill │
│                 │ • Perishable Lot Expiry Dates     │ • Expired lots flagged in red     │
├─────────────────┼───────────────────────────────────┼───────────────────────────────────┤
│ 🪵 Timber/Trade │ • Dimensional Units (L x W x H)   │ • Automatic area/volume math      │
│                 │ • Unit-of-Measure (UoM) Conversion│ • Fractional quantities (e.g. 2.4)│
└─────────────────┴───────────────────────────────────┴───────────────────────────────────┘
```

---

## 5. Behind-the-Scenes Verification Guide

When testing locally, you can open your developer tools and database to confirm that the backend state matches what the UI shows.

### A. Verifying Surface Routing
The routing headers (`x-surface`, `x-tenant-slug`, `x-locale`) are set by the server-side proxy (`src/proxy.ts`) on the *rewritten internal request* — they never appear in the browser's DevTools Network tab, so do not file a bug when you cannot see them. Verify routing by its observable effects instead:
* `roma.serveos.localhost:3000` renders the Roma storefront, `app.*` the dashboard, `admin.*` the admin console, and the bare root domain the marketing site.
* Arabic marketing pages (`/ar/...`) render with `dir="rtl"` and `lang="ar"` on the `<html>` element (inspect via DevTools **Elements** tab).
* Spoofing is rejected: adding an `x-tenant-slug: roma` header yourself on an `app.*` request must NOT surface Roma's data — the proxy strips client-sent copies.

The POS app's `X-POS-Cashier` header carries an opaque cashier session token sent by the Electron main process (`pos-main.ts:367`, only when a cashier is signed in), not a browser, so it is also invisible in DevTools; it can be observed in the Next.js server's request logs if needed.

### B. Checking Database State via Command Line
`npm run test` runs the Vitest suite — it does not inspect the database. To check whether your test sale or shift actually landed, query the database directly with `psql` using the `DATABASE_URL` from the environment you are testing against (`.env.local` for local dev, `.env.test` for the test DB):

```bash
# Latest orders
psql "$DATABASE_URL" -c "select id, order_number, status, payment_status, total, placed_at from orders order by placed_at desc limit 10;"

# Active POS shifts — an open shift has status = 'open' and an opening_float
psql "$DATABASE_URL" -c "select id, status, opening_float, opened_at from pos_shifts order by opened_at desc limit 5;"
```

(The Supabase dashboard's SQL editor works for the same queries if you prefer a UI. `npm run db:check` only reports migration status, not row data.)

### C. Checking Payment Proof Media in Supabase Storage
* Uploaded offline receipts are stored under the `media` storage bucket.
* Verify that the database column `orders.payment_proof_url` contains a valid URL string pointing to the uploaded asset.

---

## 6. Top 10 Bug Hotspots in ServeOS (Where Things Usually Break)

Keep a sharp eye out for these 10 common failure points:

1. **Floating Point Rounding in Totals:** Total ending in `.9999` instead of `.00`.
2. **Missing Required Modifier:** Adding an item to cart when required options weren't selected.
3. **Double Click Submissions:** Tapping "Place Order" or "Pay" twice rapidly creating 2 duplicate orders.
4. **Offline Sync Duplication:** POS syncing the same buffered offline sale twice upon reconnection.
5. **Staff Permission Leak:** Staff member accessing `/dashboard/settings` or `/dashboard/analytics` by typing the URL directly.
6. **Cross-Tenant ID Spoofing:** Passing another tenant's product or order UUID in an API call.
7. **RTL Layout Breakage:** Icons or arrows pointing the wrong direction in Arabic (`/ar`) mode, or text overflowing horizontally.
8. **Cash Drawer Over/Short Math:** Blind close calculating variance with reversed signs (e.g., reporting a shortage as an overage).
9. **Negative Stock on Retail:** Retail products allowing checkout when stock is 0.
10. **Receipt Image Upload Timeout:** Uploading a large photo ($> 5\text{MB}$) failing without a user-friendly error message.

---

## 7. Next Steps for You

1. Open **[Execution Checklist & Findings Log](2026-08-18-qa-findings-log.md)** in your editor.
2. Pick **Journey 1** or **Journey 2** to start.
3. Run through the steps in this playbook.
4. Mark items 🟩 **PASS** or 🟥 **FAIL** in your findings log.
5. If you hit any unexpected behavior, copy the bug template and write down what happened!
