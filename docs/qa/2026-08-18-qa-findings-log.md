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
| **`TC-AUTH-001`** | Dashboard (`app.*`) | Tenant Registration & Validations | ⬜ NOT TESTED | |
| **`TC-AUTH-002`** | Dashboard (`app.*`) | Unapproved Tenant Login Lockout | ⬜ NOT TESTED | |
| **`TC-AUTH-003`** | Dashboard (`app.*`) | RBAC Route Protection (Staff restricted) | ⬜ NOT TESTED | |
| **`TC-AUTH-004`** | Dashboard (`app.*`) | Session Logout & Invalidation | ⬜ NOT TESTED | |
| **`TC-STORE-001`**| Storefront (`{slug}.*`)| Product Catalog & Category Filtering | ⬜ NOT TESTED | |
| **`TC-STORE-002`**| Storefront (`{slug}.*`)| Required & Optional Modifier Selection | ⬜ NOT TESTED | |
| **`TC-STORE-003`**| Storefront (`{slug}.*`)| Out-of-Stock Item Restriction | ⬜ NOT TESTED | |
| **`TC-STORE-004`**| Storefront (`{slug}.*`)| Offline Payment & Receipt Attachment | ⬜ NOT TESTED | |
| **`TC-STORE-005`**| Storefront (`{slug}.*`)| Order Scheduling (Date & Time Picker) | ⬜ NOT TESTED | |
| **`TC-STORE-006`**| Storefront (`{slug}.*`)| Order Cancellation while Pending | ⬜ NOT TESTED | |
| **`TC-DASH-001`** | Dashboard (`app.*`) | Live Order Status State Machine Transitions | ⬜ NOT TESTED | |
| **`TC-DASH-002`** | Dashboard (`app.*`) | Offline Payment Verification & Rejection | ⬜ NOT TESTED | |
| **`TC-DASH-003`** | Dashboard (`app.*`) | Menu Category & Product CRUD | ⬜ NOT TESTED | |
| **`TC-DASH-004`** | Dashboard (`app.*`) | Recipe (BOM) Ingredient Linking | ⬜ NOT TESTED | |
| **`TC-DASH-005`** | Dashboard (`app.*`) | Purchase Order Lifecycle & Goods Receiving | ⬜ NOT TESTED | |
| **`TC-DASH-006`** | Dashboard (`app.*`) | POS Device Pairing Code Generation | ⬜ NOT TESTED | |
| **`TC-DASH-007`** | Dashboard (`app.*`) | Cross-Channel Financial Analytics Reports | ⬜ NOT TESTED | |
| **`TC-POS-001`**  | POS App (`apps/pos`) | First-Time Device Pairing via Code | ⬜ NOT TESTED | |
| **`TC-POS-002`**  | POS App (`apps/pos`) | Shift Open & Starting Cash Float | ⬜ NOT TESTED | |
| **`TC-POS-003`**  | POS App (`apps/pos`) | Ring Sale with Split Tender (Cash + Card) | ⬜ NOT TESTED | |
| **`TC-POS-004`**  | POS App (`apps/pos`) | Line Item Void & Discount with Reason Code| ⬜ NOT TESTED | |
| **`TC-POS-005`**  | POS App (`apps/pos`) | Cash Drawer Movement (Pay-In/Out/Drop) | ⬜ NOT TESTED | |
| **`TC-POS-006`**  | POS App (`apps/pos`) | Shift Close, Blind Count & Z-Report | ⬜ NOT TESTED | |
| **`TC-POS-007`**  | POS App (`apps/pos`) | Offline Sales Buffering & Background Sync | ⬜ NOT TESTED | |
| **`TC-ADMIN-001`**| Admin (`admin.*`)   | Super Admin Authentication | ⬜ NOT TESTED | |
| **`TC-ADMIN-002`**| Admin (`admin.*`)   | Tenant Review & Approval Workflow | ⬜ NOT TESTED | |
| **`TC-ADMIN-003`**| Admin (`admin.*`)   | Plan Entitlement Override & Gating | ⬜ NOT TESTED | |
| **`TC-ADMIN-004`**| Admin (`admin.*`)   | Tenant Suspension & Reactivation | ⬜ NOT TESTED | |
| **`TC-SEC-001`**  | API / Database      | Cross-Tenant RLS Data Isolation | ⬜ NOT TESTED | |
| **`TC-SEC-002`**  | API / Database      | Tamper-Evident Audit Hash Chain Integrity | ⬜ NOT TESTED | |
| **`TC-I18N-001`** | Marketing & Storefront| Arabic (`/ar`) RTL Layout & Typography | ⬜ NOT TESTED | |
| **`TC-I18N-002`** | Storefront & Dash   | Mobile Viewport Layout & Tap Targets ($\ge 40$px) | ⬜ NOT TESTED | |

---

## 3. Bug Findings Log

Use the template below whenever a test fails or unexpected behavior is observed:

<!--
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
-->

*(No bugs logged yet. Fill in as you test!)*

---

## 4. Execution Summary

* **Total Scenarios:** 32
* **Passed:** 0
* **Failed:** 0
* **Blocked:** 0
* **Pending:** 32
