# ServeOS Domain Glossary

> This file is the **single source of truth** for all domain terminology used across the ServeOS platform. It exists to align communication between product, engineering, design, and business teams. 
> 
> **How to maintain this file:**
> - Add new terms when new business concepts are introduced.
> - Keep definitions concise, precise, and free of implementation details (no table names, no file paths, no code references).
> - Group related terms logically.
> - Always use these exact terms in specifications, code, and discussions.

## Core Platform Concepts

- **Tenant**: A business (restaurant, retail shop, pharmacy, timber yard) that subscribes to ServeOS. Identified by a unique slug.
- **Surface**: One of the 5 user-facing applications (Storefront PWA, Merchant Dashboard, Admin Console, Marketing Site, Desktop POS).
- **Vertical**: The type of business a tenant operates — restaurant, retail, pharmacy, or timber. Each vertical unlocks different capabilities.
- **Capability**: A feature that is enabled or disabled per vertical (e.g. modifiers for restaurants, variants for retail, prescriptions for pharmacy, cutLists for timber).

## Users & Roles

- **Platform Admin (super admin)**: ServeOS operator. Approves or rejects tenant applications, suspends and reactivates tenants, confirms or rejects subscription invoice payments, and views platform revenue.
- **Owner**: Tenant business owner — full control over their tenant.
- **Manager**: Tenant staff with everything an owner has except tenant settings, plan changes, billing and prescription review. Can approve POS discounts and refunds, reconcile drawers, and manage inventory, purchasing and suppliers.
- **Staff**: Tenant employee who sells at the POS, handles orders, views inventory and takes stock counts.
- **Pharmacist**: Licensed reviewer in a pharmacy tenant: shop-floor permissions plus prescription review, and nothing administrative.
- **Cashier**: Not a separate role — any staff user signed in at the POS with the right to sell.
- **Customer**: End consumer who places orders through the storefront or WhatsApp.

## Subscription & Billing

- **Plan**: Subscription tier with resource limits and feature entitlements. Four plans, priced in EGP per month: Free (0), Starter (499), Growth (699), Professional (1099).
- **Subscription**: A tenant's active plan instance with billing period and status.
- **Entitlement**: A feature or limit gate derived from the tenant's plan. Limits: branches, staff, products, WhatsApp numbers, orders per month, messages per month. Features: WhatsApp, custom domain, custom theme, advanced analytics, online ordering (and a reservations flag that is off on every plan).
- **Invoice**: A subscription billing record paid manually: the tenant submits payment proof, then a platform admin confirms it (paid) or rejects it (void).

## Catalog & Products

- **Product**: A sellable item in a tenant's catalog. Has bilingual names (EN/AR), base price, and optional UoM.
- **Variant**: A discrete purchasable variation of a product with its own price (e.g. "500ml" vs "1L"). Used in retail.
- **Modifier Group**: A set of options attached to a product (e.g. "Size", "Crust Type"). Used in restaurants. Has min/max selection bounds.
- **Modifier Option**: A choice within a modifier group (e.g. "Large +35 EGP"). Has a price delta.
- **Category**: A classification for organizing products in the catalog (e.g. "Pizza", "Hinges").
- **Unit of Measure (UoM)**: How a product is measured/priced — each, g, kg, ml, l, m, m², bf (board feet). Platform-wide enumeration covering both sellable and stockable units.
- **Catalog Version**: A per-tenant counter bumped by catalog and pricing changes. The POS caches it with its offline catalog and sends it with replayed sales, so price drift can be detected.

## Ordering

- **Order**: A purchase record. Unified across ALL channels — a POS sale, web checkout, and WhatsApp order all create the same kind of Order.
- **Order Channel**: Where the order originated — web (storefront), pos (counter POS), or whatsapp.
- **Fulfillment Type**: How the order is fulfilled — pickup or delivery.
- **Order Status**: Lifecycle states — pending → confirmed → preparing → ready → out_for_delivery → completed (or rejected/cancelled).
- **Payment Status**: unpaid, pending_verification (a non-cash online payment awaiting staff confirmation), partially_paid, paid, partially_refunded, refunded.
- **Status Token**: A unique opaque token per order used for anonymous order tracking URLs.

## Point of Sale (POS)

- **Device**: A physical POS terminal (Electron desktop app) paired with a specific tenant and branch.
- **Pairing Code**: An 8-character, single-use code minted in the dashboard to pair a new POS device. Expires 10 minutes after it is created.
- **Cashier Session**: A staff user's sign-in on a paired POS device, by email and password. Lasts 12 hours and uses its own token (stored hashed), not the web session cookie.
- **Shift**: A cash drawer session — opened with a float, receives sales, can have cash movements, closed with a count.
- **Opening Float**: The amount of cash placed in the drawer when a shift opens.
- **Cash Count**: A physical count of cash in the drawer — can be opening, closing, or mid-shift. Records denominations and calculates variance.
- **Cash Movement**: Non-sale cash in/out of the drawer — pay-in (adding change), pay-out (expenses), safe-drop (removing excess), no-sale (drawer pop without a transaction).
- **Tender**: A payment against an order — cash, card, or other. Supports split payments, tips, and change calculation.
- **Held Ticket**: A parked cart draft stored on the server — lets a cashier pause an order and resume it on any register in the same branch.
- **X Report**: Mid-shift sales summary — non-resetting, can be pulled multiple times.
- **Z Report**: End-of-shift summary — pulled when closing a shift, tied to the cash count.
- **Adjustment Event**: An append-only record of a void or discount (line void, order void, line discount, order discount) with who did it and who authorized it.
- **Manager Override / Grant**: A single-use token, valid for 2 minutes, issued when a manager signs in at the till to approve a privileged action for a cashier (e.g. a discount, a refund, an over-threshold pay-out or closing another cashier's drawer).
- **Receipt**: The idempotency map between a device's client-side order UUID and the server-created order — prevents duplicate sales.

## Inventory & Stock

- **Inventory Item**: A trackable stockable material — can be an ingredient (for recipes), finished_good (retail), or raw_material (timber).
- **Storage Location**: A named place within a branch where inventory is kept — kitchen, retail, back_of_house, or transit.
- **Lot**: A specific batch of an inventory item received at a specific time, with optional expiry. FIFO deduction.
- **Stock Ledger**: The append-only truth for inventory movement — every stock change (receive, sale deduction, adjustment, count, transfer, waste, refund restock, production) is a ledger entry.
- **On-Hand**: The current quantity of an inventory item at a location. Derivable from the stock ledger.
- **Recipe / BOM**: A Bill of Materials — defines the ingredient items and quantities consumed when a product is sold. Used in restaurants.
- **Product Inventory Link**: The binding between a sellable product and its inventory behavior — either recipe (deduct ingredients) or finished_good (deduct the item directly).
- **Stock Count**: A physical inventory count session — opened, lines are counted, then committed (adjusting ledger to reality).
- **Reorder Rule**: Per-item, per-location reorder point and quantity. The reorder check raises low-stock alerts and pre-fills draft purchase orders from it.

## Purchasing

- **Supplier**: A vendor from whom the tenant buys inventory.
- **Purchase Order (PO)**: A request to a supplier for inventory items — lifecycle: draft → sent → partially_received → received → closed, or cancelled from draft/sent.
- **PO Line**: A line item on a purchase order — item, quantity ordered, unit cost, UoM.
- **Receiving**: The act of accepting delivered goods against a PO — creates inventory lots and stock ledger entries.

## Branches & Delivery

- **Branch**: A physical location/outlet of a tenant's business. Has opening hours, address, and can accept/refuse orders.
- **Delivery Area**: A geographic zone served by a branch — with delivery fee, minimum order amount, and estimated delivery time.

## Audit & Security

- **Audit Event**: A tamper-evident record of an action. Hash-chained (SHA-256) per tenant — each event references the previous event's hash. Append-only.
- **Audit Chain Head**: The latest sequence number and hash in a tenant's audit chain.
- **Fingerprint**: Device/session metadata attached to audit events — deviceId, appVersion, IP, userAgent.
- **Chain Verification**: Walking a tenant's audit chain and checking that each entry's hash matches the recomputed hash from its data + previous hash. Detects tampering.

## Notifications & Communications

- **Notification**: An in-app alert for staff — can target a specific user or a role. Has type, severity, and read/unread state.
- **Notification Outbox**: A store-and-forward queue for transactional emails — with retry logic and backoff.
- **Email Event**: Delivery receipts, bounces, and complaints from the email provider (Resend).

## Customers

- **Customer**: A registered end-user profile for storefront ordering.
- **Customer Session**: An authentication session for customer-facing storefront access.

## Prescriptions (Pharmacy Vertical)

- **Prescription**: An uploaded prescription image required before ordering prescription-only items. Goes pending → approved or rejected by a user with prescription-review rights (pharmacist or owner).

## WhatsApp Commerce

- **WhatsApp Account**: A connected WhatsApp Business phone number for a tenant.
- **WhatsApp Conversation**: A stateful ordering session with a customer over WhatsApp — tracks cart, branch and step (idle, branch, categories, products, variant, cart, fulfillment, contact, confirm, placed).
- **Cart Handoff Token**: A single-use token (60 minutes) that carries a WhatsApp cart into the storefront when the chat cannot finish the order — delivery orders and products with required modifiers.

## Fiscal Compliance (planned — not implemented)

- **ETA (Egyptian Tax Authority)**: Egypt's e-invoicing / e-receipt mandate. In scope as Spec 11 (roadmap decision D8); no ETA integration exists in the code yet.
- **ZATCA**: Saudi Arabia's e-invoicing authority. A high-level PRD exists (`docs/prds/prd-high-zatca-einvoicing.md`); nothing is implemented.
