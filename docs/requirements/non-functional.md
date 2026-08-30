# Non-Functional Requirements (NFRs)

This document specifies the architectural qualities, constraints, and non-functional guarantees of the ServeOS platform. It is designed to guide engineering decisions and set clear expectations for system behavior.

---

## 1. Performance & Latency Budgets

ServeOS serves three distinct interfaces: Web Storefront, Merchant Dashboard, and POS Desktop App. Each has distinct performance requirements.

### Web Storefront & PWA (Next.js 16)
- **Time to First Byte (TTFB)**: P95 < 200ms
- **Largest Contentful Paint (LCP)**: P95 < 1.5s
- **Architecture**: Next.js App Router with Server-Side Rendering (SSR) and edge caching via CDN. Breaking changes from earlier Next.js versions are adopted to optimize route segments.

### Merchant Dashboard
- **Page Load**: P95 < 500ms
- **Mutation Latency**: P95 < 300ms for Server Actions.
- **Architecture**: Optimistic UI updates where possible to mask network latency.

### POS API (`/api/pos/v1/*`)
- **Transaction Speed**: P99 response time < 100ms for sales recording and tender processing.
- **Critical Path**: High-frequency endpoints avoid large payloads and complex aggregations.

### Database Query Constraints
- **Zero Table Scans**: No full table scans allowed on high-frequency paths.
- **Tenant Scoping**: All queries must be strictly scoped by the `tenant_id` index.
- **Connection Management**: Connection pooling is mandatory, utilizing PgBouncer or Supabase AWS poolers to maintain low overhead per query.

### POS Offline Tolerance
> [!IMPORTANT]
> The POS must function during network outages to ensure uninterrupted sales.

- **Local Caching**: Local SQLite cache maintains product catalogs, pricing, and active shift state.
- **Batch Synchronization**: Offline events (sales, tenders, cash movements) are queued and pushed via batch ingestion APIs (up to 50 events/batch) upon network recovery.

---

## 2. Security & Data Isolation

As a multi-tenant SaaS platform, strict isolation and security boundaries are paramount.

### Database Multi-Tenancy
- **Row-Level Security (RLS)**: Enforced via `FORCE ROW LEVEL SECURITY` on all tenant-scoped tables in PostgreSQL.
- **Transaction Wrapper**: The `withTenant()` utility ensures `SET LOCAL app.tenant_id` is applied to every transaction, eliminating accidental cross-tenant data leaks.

### Role Privilege Enforcement
- **Database Role**: The application connects using the `serveos_app` role.
- **Privileges**: Configured with `NOSUPERUSER NOBYPASSRLS` to guarantee RLS policies are always evaluated.

### Authentication Mechanisms

| Interface | Mechanism | Details |
| :--- | :--- | :--- |
| **Dashboard/Admin** | Session Cookies | `serveos_session` & `serveos_admin_session` (HttpOnly, Secure, SameSite). |
| **POS Register** | Tokens | Long-lived device Bearer tokens + short-lived hashed cashier session tokens (`pos_cashier_sessions`). |
| **Web Storefront** | Cookies | Ephemeral or authenticated customer session cookies (`CUSTOMER_COOKIE`). |
| **WhatsApp** | HMAC Webhooks | SHA-256 signature verification (`x-hub-signature-256`). |
| **Email Webhooks** | Svix Signatures | Verification using `svix-id`, `svix-timestamp`, and `svix-signature`. |

### Cryptographic Audit Trail
> [!WARNING]
> Audit logs are highly sensitive and must be immutable.

- **Append-Only Ledger**: The `audit_events` table is an append-only hash-chained ledger.
- **Chaining Function**: `entry_hash = sha256(canonical(prev_hash, seq, tenant, actor, action, metadata))`
- **Tamper Detection**: Database triggers prevent updates or deletes to existing audit records.

### Password Hashing
- **Algorithm**: Secure bcrypt/scrypt hashing for all staff and customer credentials.
- **Super-Admin**: 192-bit generated passwords, periodically rotated.

---

## 3. Scalability & Concurrency Control

ServeOS must support thousands of isolated tenants with minimal connection footprint.

### Concurrency & Lock Management

> [!CAUTION]
> Avoid deadlocks by acquiring locks in a consistent order and minimizing lock duration.

| Domain | Lock Mechanism | Purpose |
| :--- | :--- | :--- |
| **Order Numbers** | `pg_advisory_xact_lock(hashtext(tenant_id))` | Guarantees gapless, monotonic sequence generation per tenant without locking entire tables. |
| **Audit Chain Head** | Row-level Lock (`FOR UPDATE`) | Tenant-scoped transaction locks on `audit_chain_heads` for strictly serialized hash sequencing. |
| **Inventory FIFO Lots**| Row-level Lock (`FOR UPDATE`) | Prevents race conditions and inventory overselling during recipe deduction. |
| **Cash Shifts** | Partial Unique Index | `unique(device_id) WHERE status = 'open'` ensures at most one active shift per physical cash drawer. |

---

## 4. Reliability, Availability & Disaster Recovery

### High Availability
- **Compute**: Hosted on Vercel Edge/Serverless environments.
- **Database**: Supabase High-Availability (HA) Postgres clusters.

### Automated Backups
- **Schedule**: Nightly automated `pg_dump` of both production and QA databases at 03:00 UTC.
- **Storage**: Encrypted and uploaded to Cloudflare R2 via GitHub Actions (`.github/workflows/db-backup.yml`).

### Disaster Recovery
- **Recovery Point Objective (RPO)**: < 24 hours.
- **Recovery Time Objective (RTO)**: < 1 hour.
- **Validation**: Regular, documented restore drills (`docs/references/backup-restore.md`).

### Zero-Downtime Migration Safety
> [!NOTE]
> Database schema migrations are integrated into the deployment pipeline to prevent drift.

- **Process**: `scripts/release-migrate.ts` executes Drizzle ORM migrations during the `vercel-build` phase.
- **Safety**: Migration failures abort the deployment *before* traffic switch, preventing application/database schema mismatches.

---

## 5. Compliance & Regional Regulations

ServeOS targets merchants in the MENA region, necessitating strict adherence to local tax and data regulations.

### Egyptian Tax Authority (ETA)
- **E-Invoicing & E-Receipts**: Compliant with Spec 11 / Decision D8.
- **Integration**: Real-time integration with ETA APIs.
- **Receipts**: Generation of signed QR codes.
- **Classification**: EGS/GS1 tax classification mappings.

### Saudi Arabia ZATCA
- **Phase 2 (PRD-003)**: Compliant cryptographic invoice stamping.
- **Onboarding**: CSID (Cryptographic Stamp Identifier) generation and management.
- **Format**: UBL 2.1 XML generation for reporting and clearance.

### Data Protection
- **Audit Logging**: Mandatory logging of all sensitive PII (Personally Identifiable Information) reads and data export actions by staff.

---

## 6. Internationalization & Localization (i18n / l10n)

### Bilingual Support
- **Locales**: Native Arabic (`ar`) as default, and English (`en`).
- **Scope**: Storefronts, merchant dashboard, and marketing pages.

### Bi-directional Typography
- **Layout**: Dynamic RTL (Right-to-Left) and LTR (Left-to-Right) document layout rendering based on the `x-locale` request header or user preference.

### Currencies & Number Formatting
- **Currencies**: Native formatting for Egyptian Pound (`EGP`) and Saudi Riyal (`SAR`).
- **Measurements**: Standard fractional units with explicit Units of Measure (`unit_of_measure`) for inventory and recipe precision.

---

## 7. Observability & Health Checks

### Health Probes
- **Endpoint**: `/api/health` canary endpoint.
- **Characteristics**: Lightweight, zero-DB dependency to isolate compute health from database health.

### In-App Operational Notifications
- **Alert Queue**: Real-time staff notifications for critical operational events.
- **Event Types**: Cash shift variances, stock depletion warnings, and Purchase Order (PO) status changes.
