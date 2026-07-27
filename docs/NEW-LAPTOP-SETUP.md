# ServeOS — New Laptop Setup & Test Reference

Everything needed to get ServeOS running on a fresh macOS machine, plus all test
URLs, users, and seed data.

> **Why the README isn't enough:** the README's "Setup" section describes a
> Supabase-backed local DB, but the actual dev setup uses a **local Postgres on
> port 5433** with role `serveos_app`. This doc reflects what the app is really
> wired to (`.env.local` / `.env.test`), which are **gitignored and will not be
> in your clone** — you recreate them below.

---

## Part 1 — Get the app running

### 0. Prerequisites (macOS)

| Tool | Why | Install |
|------|-----|---------|
| Xcode Command Line Tools | git + native build toolchain | `xcode-select --install` |
| **nvm + Node 22.23.1** | app targets Node 22 (system Node is too old) | see step 2 |
| **Docker Desktop** | cleanest way to run the local Postgres | https://www.docker.com/products/docker-desktop/ |
| Google Chrome | resolves `*.localhost` automatically (Safari does not) | optional but easiest |

### 1. Clone

```bash
git clone <your-repo-url> ServeOs
cd ServeOs
```

### 2. Node 22 via nvm

```bash
# install nvm if you don't have it
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart the shell, then:
nvm install 22.23.1
nvm use 22.23.1
node -v   # should print v22.23.1
```

> If a tool/non-interactive shell can't see Node, prepend it to PATH manually:
> `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`

### 3. Install dependencies

```bash
npm ci
```

Use **`npm ci`**, not `npm install` — it installs exactly from the committed
`package-lock.json` and won't churn the lockfile. (`apps/pos` pulls in `electron`
and an *optional* `better-sqlite3`; a failed native build of the latter is
non-fatal and only affects the POS desktop app.)

### 4. Local Postgres (Docker — recommended)

The app connects at `127.0.0.1:5433` as role `serveos_app`. The role **must not be
a superuser** — the schema uses `FORCE ROW LEVEL SECURITY` for tenant isolation,
and a superuser silently bypasses RLS.

```bash
# start Postgres 16, host port 5433 -> container 5432
docker run -d --name serveos-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16

# wait ~3s for it to accept connections, then create the app role + both DBs
docker exec -i serveos-pg psql -U postgres <<'SQL'
CREATE ROLE serveos_app WITH LOGIN PASSWORD 'serveos' CREATEDB NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE serveos      OWNER serveos_app;
CREATE DATABASE serveos_test OWNER serveos_app;
SQL
```

To start/stop later: `docker start serveos-pg` / `docker stop serveos-pg`.

<details>
<summary><strong>Alternative: Homebrew Postgres</strong></summary>

```bash
brew install postgresql@16
brew services start postgresql@16   # runs on default port 5432
psql postgres -c "CREATE ROLE serveos_app LOGIN PASSWORD 'serveos' CREATEDB NOSUPERUSER NOBYPASSRLS;"
psql postgres -c "CREATE DATABASE serveos      OWNER serveos_app;"
psql postgres -c "CREATE DATABASE serveos_test OWNER serveos_app;"
```

Homebrew Postgres listens on **5432**, so change the `5433` to `5432` in both
`.env` files in step 5 (or reconfigure the cluster to 5433).
</details>

### 5. Recreate the env files (gitignored — not in your clone)

Create **`.env.local`**:

```
DATABASE_URL=postgresql://serveos_app:serveos@127.0.0.1:5433/serveos
ROOT_DOMAIN=serveos.localhost
```

Create **`.env.test`**:

```
DATABASE_URL=postgresql://serveos_app:serveos@127.0.0.1:5433/serveos_test
ROOT_DOMAIN=serveos.localhost
```

### 6. Run migrations (both databases)

```bash
npm run db:migrate         # dev DB (serveos)
npm run db:migrate:test    # test DB (serveos_test)
```

### 7. Seed data

```bash
npm run db:seed                              # Pizza Roma (restaurant) + platform admin
npx tsx scripts/seed-retail-showcase.ts      # Nobio (retail: variants + stock) — optional
npm run pos:demo:code                        # POS demo tenant on TEST db + prints a pairing code — optional
```

### 8. Map the subdomains (`/etc/hosts`)

Host-based routing needs the subdomains to resolve to localhost. Chrome does this
automatically for `*.localhost`; for Safari/Firefox/curl add these lines:

```bash
sudo tee -a /etc/hosts >/dev/null <<'HOSTS'
127.0.0.1 serveos.localhost
127.0.0.1 www.serveos.localhost
127.0.0.1 app.serveos.localhost
127.0.0.1 admin.serveos.localhost
127.0.0.1 roma.serveos.localhost
127.0.0.1 nobio.serveos.localhost
127.0.0.1 posdemo.serveos.localhost
HOSTS
```

### 9. Run the app

```bash
npm run dev     # http://serveos.localhost:3000
```

### 10. Optional extras

```bash
npm run pos:dev        # POS desktop app (Electron + Vite dev)
npm run test           # unit + integration (needs serveos_test migrated)
npx playwright install # one-time, before the line below
npm run test:e2e       # Playwright smoke tests
```

---

## Part 2 — Test URLs (dev, port 3000)

| Surface | URL |
|--------|-----|
| Marketing site | http://serveos.localhost:3000 |
| **Dashboard** login | http://app.serveos.localhost:3000/login |
| Dashboard home | http://app.serveos.localhost:3000/dashboard |
| Billing / subscription settings | http://app.serveos.localhost:3000/dashboard/settings/billing |
| Staff / payment-methods / taxes settings | http://app.serveos.localhost:3000/dashboard/settings |
| **Admin console** login | http://admin.serveos.localhost:3000/admin/login |
| Admin — pending restaurant approvals | http://admin.serveos.localhost:3000/admin/approvals |
| Admin — subscription invoice queue | http://admin.serveos.localhost:3000/admin/billing |
| Admin — tenants / audit | http://admin.serveos.localhost:3000/admin/tenants · `/admin/audit` |
| **Storefront** — Pizza Roma (restaurant) | http://roma.serveos.localhost:3000 |
| **Storefront** — Nobio (retail) | http://nobio.serveos.localhost:3000 |

> The dashboard login form takes **tenant slug + email + password** (e.g. slug
> `roma`). Admin login is email + password only.

---

## Part 3 — Test users & credentials

### Platform (super admin)
| Email | Password | Where |
|-------|----------|-------|
| `admin@serveos.com` | `admin1234` | `admin.serveos.localhost:3000/admin/login` |

### Pizza Roma — slug `roma` (`app.serveos.localhost:3000/login`)
| Role | Name | Email | Password |
|------|------|-------|----------|
| Owner | Sam Adel | `owner@roma.com` | `owner1234` |
| Manager | Nour Khalil | `manager@roma.com` | `manager1234` |
| Staff | Karim Nasser | `staff@roma.com` | `staff1234` |

> These are **local seed credentials only** — not real secrets.

---

## Part 3b — Production (deployed on `serveos.tech`)

> ⚠️ **Security note:** the deployed Roma tenant currently runs on the **same
> default seed passwords** (`owner1234`, `admin1234`) that ship in `scripts/seed.ts`
> and `scripts/_prod.ts`. They work for testing today, but `admin@serveos.com /
> admin1234` is a platform-wide super admin on the live site — **rotate it** (and
> ideally the Roma owner) before this is anything more than a demo.

### Production URLs
| Surface | URL |
|--------|-----|
| Marketing | https://serveos.tech |
| Dashboard login | https://app.serveos.tech/login |
| Admin console login | https://admin.serveos.tech/admin/login |
| Roma storefront | https://roma.serveos.tech |
| Raw Vercel deployment | https://serve-os-puce.vercel.app |

> `serveos.com` 302-redirects to `serveos.tech`. Vercel auto-deploys `main`; DB
> migrations against Supabase are a **separate manual step** (see the deploy runbook).

### Production logins

The live prod passwords are **kept out of git** (this is a shared org repo). They are
the same seed defaults as the local table above, and the full list lives in the private
setup artifact:

> https://claude.ai/code/artifact/a2e0998a-89e7-4515-8dda-9d4a9874d36c

Scopes: platform super admin (`admin@serveos.com` → `admin.serveos.tech/admin/login`);
Roma owner `owner@roma.com` (slug `roma` → `app.serveos.tech/login`, confirmed working via
`scripts/_prod.ts`); Roma manager/staff if the prod DB was seeded with the standard seed.

---

## Part 4 — Seed data reference

### `roma` — Pizza Roma (from `npm run db:seed`)
- **Vertical:** restaurant, **approved & live**. Brand: "Wood-fired Italian, made fresh".
- **Menu:** 6 categories (Pizza, Pasta, Salads, Starters, Dolci, Drinks), ~24 published products with images; several `featured`; Pizza/Pasta/Drinks carry a required **Size** modifier (Regular / +35 Large).
- **Branch:** Main Branch, accepting orders, 10:00–23:00 daily.
- **Delivery areas:** Maadi (fee 25, min 100, ETA 35m), Nasr City (fee 40, min 150, ETA 50m).
- **Tax:** VAT 14%.
- **Orders:** a couple across statuses (delivery → preparing, a pending pickup) plus popularity-signal orders so "popular products" has clear winners (Margherita, Diavola, Carbonara, Caprese).

### `nobio` — Nobio Hardware (from `scripts/seed-retail-showcase.ts`)
- **Vertical:** retail, on a **pro trial**. Demonstrates variants + stock states.
- Categories: Hinges, Handles, Worktops. Products carry brands (Grimme, Egger, Nordform) and variants with **in-stock / out-of-stock (0) / untracked (null)** quantities.

### `posdemo` — POS Demo Diner (from `npm run pos:demo:code`, **test DB**)
- Tenant + Main Counter branch + small menu (Margherita +extras, Pepperoni, Cola).
- Prints a fresh **24-hour POS pairing code** each run — use it to pair the POS app.

---

## Part 5 — Subscription billing test flow (branch `feat/subscription-billing`)

Manual/offline payment flow behind the provider interface:

1. As a **Roma owner**, go to **Billing settings** (`/dashboard/settings/billing`) →
   subscribe to a plan → mark as paid → submit a **payment-proof URL**.
   (Only one outstanding invoice per tenant is allowed; empty proof is rejected;
   proof URLs are scheme-validated to block XSS.)
2. As **platform admin**, open the **invoice queue** (`/admin/billing`) →
   **confirm** (activates the subscription) or **reject** the invoice.

---

## Part 6 — Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ECONNREFUSED 127.0.0.1:5433` | Postgres isn't running → `docker start serveos-pg` |
| Queries return **0 rows** / tenant data "leaks" | The `serveos_app` role is a **superuser** — recreate it with `NOSUPERUSER NOBYPASSRLS` (RLS is bypassed by superusers) |
| `roma.serveos.localhost` won't load | Add `/etc/hosts` entries (step 8), or use Chrome |
| Storefront shows "getting ready"/empty | Tenant not seeded/approved → run `npm run db:seed` |
| `DATABASE_URL is not set` | `.env.local` / `.env.test` missing → redo step 5 |
| Don't run bare `npm install` | Use `npm ci`; avoid committing `package-lock.json` churn |

---

## Quick reference — one-shot bring-up

```bash
nvm use 22.23.1
npm ci
docker run -d --name serveos-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16
sleep 3
docker exec -i serveos-pg psql -U postgres <<'SQL'
CREATE ROLE serveos_app WITH LOGIN PASSWORD 'serveos' CREATEDB NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE serveos      OWNER serveos_app;
CREATE DATABASE serveos_test OWNER serveos_app;
SQL
# create .env.local and .env.test (Part 1, step 5)
npm run db:migrate && npm run db:migrate:test
npm run db:seed
npm run dev
```
