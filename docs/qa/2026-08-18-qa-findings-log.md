# ServeOS QA: Execution Checklist & Findings Log

**Execution Date:** 2026-08-18  
**Tester:**  
**Environment:** Local Dev (`serveos.localhost:3000`) / QA Staging (`qa.serveos.tech`)  
**Branch:** `docs/142-qa-user-journeys`  
**Reference Document:** [Master User Journeys and Test Scenarios](2026-08-18-user-journeys-and-test-scenarios.md)  
**Related Issue:** [#142](https://github.com/Ai-NativeLab/ServeOs/issues/142)

---

## 1. Quick Test Credentials & Local Hosts

| Surface | Host / URL | Role / User | Credentials |
|---|---|---|---|
| **Marketing** | `http://serveos.localhost:3000` | Visitor | — |
| **Storefront** | `http://roma.serveos.localhost:3000` | Customer / Guest | — |
| **Dashboard** | `http://app.serveos.localhost:3000/login` | Owner | `owner@roma.com` / `owner1234` |
| **Dashboard** | `http://app.serveos.localhost:3000/login` | Manager | `manager@roma.com` / `manager1234` |
| **Dashboard** | `http://app.serveos.localhost:3000/login` | Staff / Kitchen | `staff@roma.com` / `staff1234` |
| **Admin** | `http://admin.serveos.localhost:3000/admin/login` | Platform Admin | `admin@serveos.com` / `admin1234` |
| **Electron POS**| `apps/pos` (`npm run pos:dev`) | Cashier | Pairing Code from Dashboard |

---

## 2. Test Execution Matrix

*Status Legend:*  
- 🟩 **PASS** — Feature behaves as expected.
- 🟥 **FAIL** — Bug found (logged in Section 3).
- 🟨 **BLOCKED** — Cannot test due to environment or dependency issue.
- ⬜ **NOT TESTED** — Pending execution.

| Scenario ID | Surface | Scenario Title | Status | Bug ID / Notes |
|---|---|---|---|---|
| **`TC-AUTH-001`** | Dashboard (`app.*`) | Tenant Registration & Validations | 🟩 PASS | Successfully registered Cairo Roasters (`cairoroasters`) |
| **`TC-AUTH-002`** | Dashboard (`app.*`) | Unapproved / Suspended Tenant Login Lockout | 🟥 FAIL | [BUG-007] Suspended/unapproved tenants can still access dashboard |
| **`TC-AUTH-003`** | Dashboard (`app.*`) | RBAC Route Protection (Staff restricted) | 🟥 FAIL | [BUG-008] Unhandled UnauthorizedError triggers generic 500 error boundary |
| **`TC-AUTH-004`** | Dashboard (`app.*`) | Session Logout & Invalidation | 🟩 PASS | Session deleted in DB, cookie cleared, audit event emitted |
| **`TC-STORE-001`**| Storefront (`{slug}.*`)| Product Catalog & Category Filtering | 🟩 PASS | Verified category & products on Cairo Roasters |
| **`TC-STORE-002`**| Storefront (`{slug}.*`)| Required & Optional Modifier Selection | 🟩 PASS | Enforced required Milk Type modifier selection |
| **`TC-STORE-003`**| Storefront (`{slug}.*`)| Out-of-Stock Item Restriction | 🟥 FAIL | [BUG-009] Restaurant template allows configuring and adding OOS items to cart |
| **`TC-STORE-004`**| Storefront (`{slug}.*`)| Offline Payment & Receipt Attachment | 🟩 PASS | Cash on delivery order placed |
| **`TC-STORE-005`**| Storefront (`{slug}.*`)| Order Scheduling (Date & Time Picker) | 🟩 PASS | Scheduled outside opening hours (3 AM) |
| **`TC-STORE-006`**| Storefront (`{slug}.*`)| Order Cancellation while Pending | 🟩 PASS | StatusPoller allows cancelling pending order with confirmation & error handling |
| **`TC-DASH-001`** | Dashboard (`app.*`) | Live Order Status State Machine Transitions | 🟩 PASS | Transitions pending->confirmed->preparing->ready->out_for_delivery->completed |
| **`TC-DASH-002`** | Dashboard (`app.*`) | Offline Payment Verification & Rejection | 🟥 FAIL | [BUG-004], [BUG-005], [BUG-006] logged |
| **`TC-DASH-003`** | Dashboard (`app.*`) | Menu Category & Product CRUD | 🟥 FAIL | [BUG-001] Direct image binary upload fails without Supabase creds |
| **`TC-DASH-004`** | Dashboard (`app.*`) | Recipe (BOM) Ingredient Linking & Auto-Deduction | 🟥 FAIL | [BUG-010] /dashboard/inventory/items/new returns 404 Not Found |
| **`TC-DASH-005`** | Dashboard (`app.*`) | Purchase Order Lifecycle & Goods Receiving | 🟥 FAIL | [BUG-012] Goods receipt saves unitCost=0, breaking 3-way match |
| **`TC-DASH-006`** | Dashboard (`app.*`) | POS Device Pairing Code Generation | 🟩 PASS | 8-char secure code with 10-min TTL & audit trail |
| **`TC-DASH-007`** | Dashboard (`app.*`) | Cross-Channel Financial Analytics Reports | 🟩 PASS | Channel breakdown, AOV, peak hours & plan upgrade prompts |
| **`TC-POS-001`**  | POS App (`apps/pos`) | First-Time Device Pairing via Code | 🟩 PASS | Device paired, persisted token & loaded till |
| **`TC-POS-002`**  | POS App (`apps/pos`) | Cashier Login & Shift Open with Float | 🟩 PASS | Opened shift with 500 EGP float, loaded menu & active ticket |
| **`TC-POS-003`**  | POS App (`apps/pos`) | Ring Sale with Split Tender (Cash + Card) | 🟩 PASS | Split tender (Cash + Card) recorded & receipt rendered |
| **`TC-POS-004`**  | POS App (`apps/pos`) | Line Item Void & Discount with Reason Code| 🟩 PASS | Applied discount, recalculated total & unified with dashboard orders |
| **`TC-POS-005`**  | POS App (`apps/pos`) | Cash Drawer Movement (Pay-In/Out/Drop) | 🟩 PASS | Recorded 300 EGP safe drop & updated expected cash |
| **`TC-POS-006`**  | POS App (`apps/pos`) | Shift Close, Blind Count & Z-Report | 🟩 PASS | Recorded blind count (300 EGP), finalized shift & returned till to open state |
| **`TC-POS-007`**  | POS App (`apps/pos`) | Offline Sales Buffering & Background Sync | 🟨 N/A | Parked in electron/_offline per Roadmap & Issue #142 |
| **`TC-ADMIN-001`**| Admin (`admin.*`)   | Super Admin Authentication | 🟩 PASS | requireSuperAdminOrRedirect routes non-admins to /admin/no-access |
| **`TC-ADMIN-002`**| Admin (`admin.*`)   | Tenant Review & Approval Workflow | 🟩 PASS | /admin/approvals lists pending stores with approve/reject actions |
| **`TC-ADMIN-003`**| Admin (`admin.*`)   | Plan Entitlement Override & Gating | 🟩 PASS | Admin detail page manages force active, plan, and invoices |
| **`TC-ADMIN-004`**| Admin (`admin.*`)   | Tenant Suspension & Reactivation | 🟩 PASS | Storefront stops serving when status = suspended |
| **`TC-SEC-001`**  | API / Database      | Cross-Tenant RLS Data Isolation | 🟩 PASS | withTenant transaction wrapper sets session app.tenant_id |
| **`TC-SEC-002`**  | API / Database      | Tamper-Evident Audit Hash Chain Integrity | 🟩 PASS | Append-only prev_hash/head_hash chain with advisory locking |
| **`TC-SEC-003`**  | API / Proxy         | Host Header Spoofing Prevention | 🟩 PASS | src/proxy.ts strips injected x-tenant-slug on non-storefront hosts |
| **`TC-I18N-001`** | Marketing & Storefront| Arabic (`/ar`) RTL Layout & Typography | 🟩 PASS | RTL dir, Cairo typography, bilingual descriptions |
| **`TC-I18N-002`** | Storefront & Dash   | Mobile Viewport Layout & Tap Targets ($\ge 40$px) | 🟩 PASS | 44px tap targets, responsive sheets, stacked grids |

---

## 3. Bug Findings Log

Use the template below whenever a test fails or unexpected behavior is observed:


### [BUG-001] Short Description of Issue
* **Scenario ID:** `TC-STORE-004`
* **Surface / URL:** `http://roma.serveos.localhost:3000/checkout`
* **Persona:** Customer
* **Severity:** High / Medium / Low
* **Steps to Reproduce:**
  1.
  2.
* **Expected Result:**
* **Actual Result:**
* **Console / Server Error:**
* **Screenshot:**
### [BUG-001] Binary Media Upload Fails with "Image storage is not configured" in Local Environment
* **Scenario ID:** `TC-DASH-003`
* **Surface / URL:** `http://app.serveos.localhost:3000/dashboard/menu/categories/new`
* **Persona:** Owner / Manager
* **Severity:** Medium (Graceful fallback available via direct URL input)
* **Steps to Reproduce:**
  1. Navigate to `/dashboard/menu/categories/new` or `/dashboard/menu/products/new`.
  2. Click "Upload image" and select a local JPG/PNG file.
* **Expected Result:** Either upload to configured storage or graceful local file handling.
* **Actual Result:** Toast error displays: `"Image storage is not configured"`.
* **Root Cause:** `/api/media-upload` requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment variables.
### [BUG-002] Storefront Cart Drawer Lacks Explicit Delete / Trash Icon for Line Items
* **Scenario ID:** `TC-STORE-001` / `TC-STORE-002`
* **Surface / URL:** `http://{slug}.serveos.localhost:3000` (Cart Drawer)
* **Persona:** Customer
* **Severity:** Low / UX Enhancement
* **Steps to Reproduce:**
  1. Add an item to the cart.
  2. Open the Cart Drawer.
* **Expected Result:** An explicit trash/remove button on each line item and/or a "Clear cart" button.
* **Actual Result:** The only way to remove an item is to repeatedly click the `−` decrement button until quantity hits 0.

---

### [BUG-003] Missing Country-Specific Mobile Phone Validation on Checkout
* **Scenario ID:** `TC-STORE-004` / `TC-STORE-001`
* **Surface / URL:** `http://{slug}.serveos.localhost:3000/checkout`
* **Persona:** Customer
* **Severity:** Medium (Data integrity & customer contactability)
* **Steps to Reproduce:**
  1. Add an item to cart and proceed to checkout for an Egyptian tenant (`EG`).
  2. Enter an invalid phone number format (e.g. `123`, `01912345678`, or letters).
  3. Submit the order.
* **Expected Result:** Client and server validation should enforce local mobile phone format (e.g. Egypt `01[0125]XXXXXXXX` or SA `05XXXXXXXX`).
* **Actual Result:** Order is accepted without validating phone structure or length.

---

### [BUG-004] Lack of Carrier & Length Validation on Vodafone Cash / Mobile Wallet Details
* **Scenario ID:** `TC-DASH-002` / `TC-STORE-004`
* **Surface / URL:** `http://app.serveos.localhost:3000/dashboard/settings/payment-methods`
* **Persona:** Merchant Owner / Manager
* **Severity:** Medium (Payment operational failure)
* **Steps to Reproduce:**
  1. Go to `/dashboard/settings/payment-methods`.
  2. Add/Edit a payment method with type **Vodafone Cash**.
  3. Enter a non-Vodafone prefix (e.g. `015...` for WE) or a number with $>11$ digits in `payToDetail`.
  4. Click **Save**.
* **Expected Result:** Form should validate that Vodafone Cash uses a valid 11-digit `010XXXXXXXX` mobile number.
* **Actual Result:** Unvalidated string is saved and displayed to customers at checkout.

---

### [BUG-005] Orders with "pending_verification" Payment Can Be Fulfilled & Completed without Prior Verification
* **Scenario ID:** `TC-DASH-001` / `TC-DASH-002`
* **Surface / URL:** `http://app.serveos.localhost:3000/dashboard/orders`
* **Persona:** Kitchen / Dispatch Staff
* **Severity:** High (Commercial risk / Fraud exposure)
* **Steps to Reproduce:**
  1. Place an online order with Vodafone Cash / InstaPay (`paymentStatus: pending_verification`).
  2. Without verifying the payment in `/dashboard/payments`, go to `/dashboard/orders`.
  3. Advance the order through `Confirmed` $\rightarrow$ `Preparing` $\rightarrow$ `Ready` $\rightarrow$ `Completed`.
* **Expected Result:** Either:
  - System should block advancing beyond `Pending` or `Preparing` until payment is confirmed for prepaid offline methods.
  - Or display a prominent warning badge: *"⚠️ Payment unverified"* on the kitchen ticket.
* **Actual Result:** Order can be marked completed and fulfilled with zero warning or gating.

---

### [BUG-006] Rejecting Offline Payment for a "Completed" Order Throws Unhandled InvalidTransitionError
* **Scenario ID:** `TC-DASH-002`
* **Surface / URL:** `http://app.serveos.localhost:3000/dashboard/payments`
* **Persona:** Merchant Owner / Manager
* **Severity:** High (Crash / State machine conflict)
* **Steps to Reproduce:**
  1. Place an order with Vodafone Cash / InstaPay (`paymentStatus: pending_verification`).
  2. Advance the order in `/dashboard/orders` until it reaches `Completed`.
  3. Go to `/dashboard/payments` and click **Reject** on that order.
* **Expected Result:** Either:
  - The "Reject" button should be disabled or hidden once an order is `Completed` (or trigger a refund/chargeback workflow).
  - Or a clear, user-friendly error message should explain: *"Cannot reject payment because order #X has already been fulfilled and completed."*
* **Actual Result:** Server throws uncaught `InvalidTransitionError: Invalid transition completed → cancelled`, triggering a generic crash toast `"Something went wrong"`.

---

### [BUG-007] Suspended or Unapproved Tenants Can Still Access and Mutate Merchant Dashboard
* **Scenario ID:** `TC-AUTH-002` / `TC-ADMIN-004`
* **Surface / URL:** `http://app.serveos.localhost:3000/dashboard`
* **Persona:** Merchant Owner / Manager
* **Severity:** High (Security & billing governance)
* **Steps to Reproduce:**
  1. Have an admin suspend a tenant via `/admin/tenants/[id]` (sets `tenants.status = "suspended"`).
  2. Log in as owner/manager of the suspended tenant at `http://app.serveos.localhost:3000/login`.
  3. Navigate to `/dashboard`.
* **Expected Result:**
  - `requireDashboardUser()` or `DashboardLayout` should check `tenant.status`.
  - If status is `suspended` or `rejected`, user should be redirected to a dedicated `/suspended` or `/pending-approval` lockout screen.
* **Actual Result:**
  - Storefront properly gates storefront visitors (`isTenantServable(tenant)`), but `DashboardLayout` has no status check. Suspended merchants can access and manage all dashboard operations unchecked.

---

### [BUG-008] RBAC Unauthorized Errors in Server Components Trigger Generic 500 Error Boundary Instead of 403 Forbidden Screen
* **Scenario ID:** `TC-AUTH-003`
* **Surface / URL:** `http://app.serveos.localhost:3000/dashboard/analytics`, `/dashboard/audit`, `/dashboard/menu`
* **Persona:** Kitchen / Dispatch Staff (`staff@roma.com`)
* **Severity:** Medium (UX & Observability)
* **Steps to Reproduce:**
  1. Log in as `staff@roma.com`.
  2. Manually navigate via address bar to `http://app.serveos.localhost:3000/dashboard/analytics` (or `/dashboard/audit`, `/dashboard/menu`).
* **Expected Result:**
  - Staff user should either be gracefully redirected to `/dashboard/orders` or presented with an informative 403 Forbidden / "Access Denied — Insufficient Permissions" state.
* **Actual Result:**
  - Page throws uncaught `UnauthorizedError("reports:view")`, which bubbles to `src/app/dashboard/error.tsx`, rendering: `"Something went wrong. This page failed to load. Try again."` with a "Retry" button.

---

### [BUG-009] Restaurant Storefront Template Fails to Enforce Out-of-Stock Product Restrictions
* **Scenario ID:** `TC-STORE-003`
* **Surface / URL:** `http://{slug}.serveos.localhost:3000` (Restaurant Template)
* **Persona:** Customer
* **Severity:** High (Order fulfillment failure / Operations risk)
* **Steps to Reproduce:**
  1. In dashboard, edit a product with `trackStock = true` and `stockQuantity = 0` (or `bpaAvailable = false`).
  2. Open the tenant's storefront on restaurant template.
  3. Locate the product card.
* **Expected Result:**
  - Card should display an `"Out of stock"` badge, dim image with grayscale, disable opening `ProductSheet`, and prevent adding to cart (identical to behavior in `ShopProductCard.tsx`).
* **Actual Result:**
  - `ProductCard.tsx` and `ProductSheet.tsx` ignore `product.inStock`. Customer can open the product sheet, configure modifiers, and add the out-of-stock dish to the cart.

### [BUG-010] Navigating to "New Inventory Item" (/dashboard/inventory/items/new) Returns 404 Not Found
* **Scenario ID:** `TC-DASH-004` / Journey 4 (Inventory)
* **Surface / URL:** `http://app.serveos.localhost:3000/dashboard/inventory/items/new`
* **Persona:** Merchant Owner / Manager
* **Severity:** High (Core functionality blocked — cannot create raw inventory items)
* **Steps to Reproduce:**
  1. Log in to dashboard as Owner/Manager.
  2. Navigate to `http://app.serveos.localhost:3000/dashboard/inventory`.
  3. Click **"New item"** button (links to `/dashboard/inventory/items/new`).
* **Expected Result:**
  - The "New Item" form should load, allowing the manager to specify Item Name, Arabic Name, Kind (Ingredient/Finished good/Raw material), Base Unit (`kg`, `g`, `l`, `ml`, `each`), SKU, and Perishable flag.
* **Actual Result:**
  - Next.js returns `404: This page could not be found.`

### [BUG-011] Recipe Detail / Edit Route (/dashboard/inventory/recipes/[id]) Returns 404 Not Found
* **Scenario ID:** `TC-DASH-004` / Journey 4 (Inventory)
* **Surface / URL:** `http://app.serveos.localhost:3000/dashboard/inventory/recipes/[id]`
* **Persona:** Merchant Owner / Manager
* **Severity:** High (Core functionality blocked — cannot add ingredients or link recipes to sellable products)
* **Steps to Reproduce:**
  1. Go to `http://app.serveos.localhost:3000/dashboard/inventory/recipes`.
  2. Enter recipe name (e.g. "Margherita") and click **"Create recipe"**.
  3. Action creates the recipe row and redirects to `/dashboard/inventory/recipes/{id}`.
* **Expected Result:**
  - Recipe Detail page should load, displaying the **Ingredients (BOM)** editor and the **Sold as (Link to Product)** form.
* **Actual Result:**
  - Next.js returns `404: This page could not be found.`

### [BUG-012] Goods Receipt Stores unitCost as 0.00, Breaking Three-Way Match & Variance Calculations
* **Scenario ID:** `TC-DASH-005` / Journey 4 (Purchasing)
* **Surface / URL:** `http://app.serveos.localhost:3000/dashboard/purchase-orders/[id]`
* **Persona:** Merchant Owner / Manager
* **Severity:** High (Financial integrity & ERP accounting failure)
* **Steps to Reproduce:**
  1. Create a PO with items (e.g. 20 kg @ 2.00 EGP = 40.00 EGP) and Send it.
  2. Click **"Receive stock"** and confirm receiving all 20 kg.
  3. Enter supplier invoice amount (e.g. 20.00 EGP or 40.00 EGP).
  4. Inspect the **Three-Way Match & Variance** strip.
* **Expected Result:**
  - **Received Total** should equal 40.00 EGP ($20\text{ kg} \times 2.00\text{ EGP/kg}$).
  - Invoiced Total vs Received should calculate the true financial variance.
* **Actual Result:**
  - **Received Total** calculates as `0.00 EGP` (and vs Ordered displays `-40.00 EGP`), because `ReceiveStockDialog.tsx` hardcoded `unitCost: 0` in its payload and `receiving.ts` recorded `0.00` directly into `po_receipt_lines`.

### [BUG-013] Close PO Throws Invalid Transition Error Immediately Following Receipt Submission
* **Scenario ID:** `TC-DASH-005` / Journey 4 (Purchasing)
* **Surface / URL:** `http://app.serveos.localhost:3000/dashboard/purchase-orders/[id]`
* **Persona:** Merchant Owner / Manager
* **Severity:** Medium (State synchronization & UX friction)
* **Steps to Reproduce:**
  1. Have a PO in `sent` status.
  2. Click **"Receive stock"** and receive all ordered quantities (PO transitions to `received`).
  3. Immediately click **"Close PO"** without hard-reloading the browser page.
* **Expected Result:**
  - Close action should execute smoothly and transition PO to `closed`.
* **Actual Result:**
  - Server throws `Invalid transition ... → closed` toast error because the client component state was stale; only succeeds after manual page refresh.

### [BUG-014] POS Electron App Default Base URL Resolved to Production Host in Dev Mode
* **Scenario ID:** `TC-POS-001` / Journey 3 (POS)
* **Surface / URL:** Desktop Electron App (`apps/pos`)
* **Persona:** Cashier / Staff / Manager
* **Severity:** Critical (Blocks entire POS in local dev environment)
* **Steps to Reproduce:**
  1. Run `npm run pos:dev` to launch Electron POS.
  2. Attempt to sign in with `roma`, `staff@roma.com`, `staff1234`.
* **Expected Result:**
  - App sends login request to `http://localhost:3000/api/pos/v1/login`.
* **Actual Result:**
  - `DEFAULT_BASE_URL` in `pos-main.ts` statically evaluated `process.env.VITE_DEV_SERVER_URL` before Vite initialized, defaulting to `"https://app.serveos.tech"`, which failed with uncaught fetch network error.

### [BUG-015] WhatsApp Cart Handoff URL Omits Local Dev Port and Hardcodes https Protocol
* **Scenario ID:** `06-whatsapp.md` / WhatsApp Sandbox
* **Surface / URL:** WhatsApp Runner (`src/server/whatsapp/runner.ts:89`)
* **Persona:** Storefront Customer
* **Severity:** Medium (Dev environment & onboarding friction)
* **Steps to Reproduce:**
  1. Run `scripts/whatsapp-sandbox.ts --slug roma`.
  2. Select an item requiring modifiers or handoff.
  3. Inspect the handoff URL sent in chat.
* **Expected Result:**
  - Handoff URL in dev should point to `http://roma.serveos.localhost:3000/?handoff=...`.
* **Actual Result:**
  - Code emits `https://roma.serveos.localhost/?handoff=...` (missing port 3000 and hardcoding https).

### [BUG-016] Customer Storefront Checkout Form Missing Prescription (Rx) Upload Input
* **Scenario ID:** `TC-STORE-004` / Pharmacy Vertical
* **Surface / URL:** `http://{slug}.serveos.localhost:3000/checkout` (Pharmacy Storefront)
* **Persona:** Pharmacy Customer
* **Severity:** High (Core vertical feature blocked — customers cannot attach doctor's Rx to regulated orders)
* **Steps to Reproduce:**
  1. Open `http://demo-pharmacy.serveos.localhost:3000`.
  2. Add an Rx-required medicine (e.g. *Augmentin 1g*) to cart.
  3. Navigate to `/checkout`.
* **Expected Result:**
  - Checkout form should display a **Prescription Upload File Input** (with image preview & file validation) that posts to `/api/prescriptions` and attaches the `prescriptionId` to the order.
* **Actual Result:**
  - `CheckoutForm.tsx` has no file upload field or prescription state handling whatsoever.



## 4. Execution Summary

* **Total Scenarios:** 34
* **Passed:** 25
* **Failed:** 8 (with 16 distinct bugs logged: `BUG-001` through `BUG-016`)
* **Out of Scope / Parked:** 1 (`TC-POS-007`)
* **Pending:** 0









