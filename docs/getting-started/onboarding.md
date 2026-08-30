# Developer Onboarding Guide

Welcome to ServeOS! This guide will walk you through setting up your local development environment, understanding our architecture, and running tests. It serves as the canonical onboarding guide for developers on macOS, Linux, and Windows.

## Prerequisites

Before starting, ensure you have the following installed:

- **Node.js 22.23.1** (We recommend using `nvm` or `nvm-windows` to manage Node versions)
- **Docker Desktop** (Required for running our local Postgres database)
  <details>
  <summary>Alternative: Homebrew Postgres (macOS)</summary>
  If you prefer not to use Docker, you can install Postgres locally via `brew install postgresql@15`. Ensure you create the necessary users and databases as described below.
  </details>
- **Google Chrome** (Recommended, as it resolves `*.localhost` domains automatically without needing hosts file modifications)

## Setup Steps

Follow these steps to get your local environment running.

### 1. Clone the Repository

```bash
git clone https://github.com/serveos/serveos.git
cd serveos
```

### 2. Install Dependencies

Ensure you are on the correct Node version and install dependencies using `npm ci`.

> [!WARNING]
> Always use `npm ci` instead of `npm install` for the initial setup to ensure a clean install matching `package-lock.json`.

```bash
nvm use
npm ci
```

### 3. Setup Local Database

We use PostgreSQL. Spin it up using Docker and configure the required role and databases.

> [!IMPORTANT]
> The `serveos_app` role MUST be created with `NOSUPERUSER NOBYPASSRLS`. Our multi-tenant architecture relies heavily on PostgreSQL Row-Level Security (RLS) for tenant isolation. If the role is superuser, RLS is bypassed, which will lead to data leaks and 0 rows returned in tenant-scoped queries.

Run the following script to create a Docker container, initialize databases, and set up the restricted role:

```bash
docker run --name serveos-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 -d postgres:15

# Wait a few seconds for the container to start, then create the role and DBs
docker exec -it serveos-pg psql -U postgres -c "CREATE ROLE serveos_app WITH LOGIN PASSWORD 'serveos_local' NOSUPERUSER NOBYPASSRLS;"
docker exec -it serveos-pg psql -U postgres -c "CREATE DATABASE serveos;"
docker exec -it serveos-pg psql -U postgres -c "CREATE DATABASE serveos_test;"
docker exec -it serveos-pg psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE serveos TO serveos_app;"
docker exec -it serveos-pg psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE serveos_test TO serveos_app;"
```

*(Note for Windows developers: The above commands run exactly the same in PowerShell or WSL2.)*

### 4. Configure Environment Variables

Create `.env.local` and `.env.test` files in the root directory. These files are gitignored.

**.env.local**
```env
DATABASE_URL=postgresql://serveos_app:serveos_local@localhost:5433/serveos
ROOT_DOMAIN=serveos.localhost
# Optional: Add Supabase Realtime env vars if testing real-time features
```

**.env.test**
```env
DATABASE_URL=postgresql://serveos_app:serveos_local@localhost:5433/serveos_test
ROOT_DOMAIN=serveos.localhost
```

### 5. Run Database Migrations

Apply the database schema to both your development and test databases.

```bash
npm run db:migrate
npm run db:migrate:test
```

### 6. Seed the Database

Populate your local database with initial test data.

```bash
# Seeds the platform admin and the default tenant (Pizza Roma)
npm run db:seed

# Optional: Seed a retail showcase tenant (Nobio Hardware)
npx tsx scripts/seed-retail-showcase.ts

# Optional: Seed test data specifically for POS device pairing
npm run pos:demo:code
```

### 7. Configure Subdomain Routing

ServeOS relies on subdomain routing for tenant isolation (e.g., `tenant.serveos.localhost`).

- **If using Google Chrome:** You don't need to do anything. Chrome automatically resolves `*.localhost` to `127.0.0.1`.
- **Other Browsers (macOS/Linux):** Add entries to your `/etc/hosts` file.
  ```text
  127.0.0.1 serveos.localhost app.serveos.localhost admin.serveos.localhost roma.serveos.localhost nobio.serveos.localhost
  ```
- **Other Browsers (Windows):** Edit `C:\Windows\System32\drivers\etc\hosts` as Administrator and add the same line.

### 8. Start the Development Server

```bash
npm run dev
```

Your environment is now running! Visit [http://serveos.localhost:3000](http://serveos.localhost:3000) to see the marketing page.

---

## Testing Your Local Setup

With the server running on port 3000, use these URLs and credentials to verify everything works.

### Test URLs

| Surface | URL |
|---------|-----|
| Marketing Site | [http://serveos.localhost:3000](http://serveos.localhost:3000) |
| Dashboard Login | [http://app.serveos.localhost:3000/login](http://app.serveos.localhost:3000/login) |
| Admin Console | [http://admin.serveos.localhost:3000/admin/login](http://admin.serveos.localhost:3000/admin/login) |
| Roma Storefront | [http://roma.serveos.localhost:3000](http://roma.serveos.localhost:3000) |
| Nobio Storefront | [http://nobio.serveos.localhost:3000](http://nobio.serveos.localhost:3000) |

### Test Users

Use these accounts (passwords are all `<role>1234`) to log in to the Dashboard or POS.

| Role | Email | Password | Tenant Slug | Notes |
|------|-------|----------|-------------|-------|
| **Platform Admin** | admin@serveos.com | `admin1234` | N/A | Has global admin console access. |
| **Roma Owner** | owner@roma.com | `owner1234` | `roma` | Full tenant access for Pizza Roma. |
| **Roma Manager** | manager@roma.com | `manager1234` | `roma` | Branch manager capabilities. |
| **Roma Staff** | staff@roma.com | `staff1234` | `roma` | POS cashier / basic staff access. |

### Seed Data Reference

Understanding the seed data generated in step 6:

- **`roma`** — Pizza Roma (Restaurant): Includes 6 menu categories, ~24 products, a Main Branch, delivery areas, and 14% VAT configuration.
- **`nobio`** — Nobio Hardware (Retail): Includes Hinges, Handles, Worktops with complex variants and stock tracking.
- **`posdemo`** — POS Demo Diner: A small menu primarily used in the `serveos_test` DB or for testing the pairing code flow.

---

## Quick One-Shot Bring-Up

If you want to wipe and reset your local database and start fresh, run this bash script block:

```bash
docker stop serveos-pg || true
docker rm serveos-pg || true
docker run --name serveos-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 -d postgres:15
sleep 5 # Wait for PG to initialize
docker exec -it serveos-pg psql -U postgres -c "CREATE ROLE serveos_app WITH LOGIN PASSWORD 'serveos_local' NOSUPERUSER NOBYPASSRLS;"
docker exec -it serveos-pg psql -U postgres -c "CREATE DATABASE serveos; CREATE DATABASE serveos_test;"
docker exec -it serveos-pg psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE serveos TO serveos_app; GRANT ALL PRIVILEGES ON DATABASE serveos_test TO serveos_app;"

cat << 'EOF' > .env.local
DATABASE_URL=postgresql://serveos_app:serveos_local@localhost:5433/serveos
ROOT_DOMAIN=serveos.localhost
EOF

cat << 'EOF' > .env.test
DATABASE_URL=postgresql://serveos_app:serveos_local@localhost:5433/serveos_test
ROOT_DOMAIN=serveos.localhost
EOF

npm run db:migrate
npm run db:migrate:test
npm run db:seed
npm run dev
```

---

## Architecture Overview

ServeOS is structured across 5 main web surfaces utilizing Next.js subdomain routing. We encapsulate domain logic across roughly 27 domain modules in `src/server/`.

For a deep dive into the system design, please read the full [Architecture Overview](file:///d:/work/AgencyOS/ServeOs/docs/architecture/overview.md).

---

## Running the POS Desktop App

Our Point of Sale application is an Electron desktop app built alongside the web app.

1. Keep the web dev server (`npm run dev`) running in your primary terminal.
2. In a second terminal, start the POS app:
   ```bash
   npm run pos:dev
   ```
3. **Device Pairing:** You can either sign in directly as an owner/manager or use a pairing code generated from the web dashboard.
4. **Context:** Every request made from the POS app automatically carries a Bearer token (device authentication) and an `X-POS-Cashier` header identifying the currently active staff member.

---

## Testing

> [!NOTE]
> Tests must run serially to avoid database contention in the test database. Do not parallelize.

- **Unit & Integration Tests (Vitest):**
  ```bash
  npm run test
  ```
  *(Requires the `serveos_test` database to be migrated).*

- **Pure Unit Tests:**
  ```bash
  npm run test:unit
  ```
  *(Tests pure logic; no database required).*

- **End-to-End Tests (Playwright):**
  ```bash
  npm run test:e2e
  ```
  *(Requires the main dev DB to be seeded. Boots the dev server automatically).*

- **POS Tests:**
  ```bash
  npm run pos:test
  npm run pos:typecheck
  ```
  *(Runs Electron app tests).*

### CI Pipeline
Our GitHub Actions CI (`.github/workflows/ci.yml`) runs typechecks, migration-drift checks, and the full test suite. It strictly runs as a non-superuser to ensure RLS policies function identically to production.

---

## Working with the Database

We use **Drizzle ORM** with **PostgreSQL**.

- **Schema Definitions:** Schema files are located within each domain module's directory (e.g., `src/server/<domain>/schema.ts`). These are all aggregated in `src/db/schema.ts`.
- **Modifying the Schema:**
  When you change a `schema.ts` file, generate a new migration:
  ```bash
  npx drizzle-kit generate
  ```
  Then apply it locally:
  ```bash
  npm run db:migrate
  npm run db:migrate:test
  ```

---

## Key Conventions

ServeOS relies on strict architectural conventions to maintain stability. For the complete guide, see the [Codebase Conventions](file:///d:/work/AgencyOS/ServeOs/docs/getting-started/codebase-conventions.md).

- **Server Components Default:** React Server Components (RSC) are used by default. Only use `'use client'` at the boundaries for interactive islands.
- **Next.js 16 APIs:** In Next.js 16, `searchParams`, `headers()`, and `cookies()` are **async Promises**. You must `await` them.
- **Business Logic:** All core business logic resides in `src/server/<domain>/`. **Never** put business logic directly in route handlers or UI components.
- **Path Aliases:** We use `@/*` mapped to `./src/*` for clean imports.

---

## Production & QA Environments

ServeOS is deployed on **Vercel** with the production database hosted on **Supabase**.

- Pushing to the `main` branch automatically triggers a deployment to **Production**.
- Pushing to the `qa` branch triggers a deployment to the **QA** environment.

For full environment details, managing secrets, and database access, read the [Environments Reference](file:///d:/work/AgencyOS/ServeOs/docs/references/environments.md).

---

## Troubleshooting

- **`ECONNREFUSED` / Database connection errors:**
  Postgres might not be running. Start your Docker container:
  ```bash
  docker start serveos-pg
  ```
- **Queries returning 0 rows / Potential data leaks:**
  Your local Postgres `serveos_app` role might be a superuser, bypassing RLS. Recreate the role strictly with `NOSUPERUSER NOBYPASSRLS`.
- **`*.localhost` domains won't load:**
  Ensure you are using Google Chrome or that you have correctly updated your `/etc/hosts` (macOS/Linux) or `C:\Windows\System32\drivers\etc\hosts` (Windows) file.
- **Storefront page is completely empty/missing data:**
  The tenant data hasn't been seeded. Run `npm run db:seed`.
- **App crashes complaining about `DATABASE_URL`:**
  Your `.env.local` or `.env.test` files are missing or misconfigured.
