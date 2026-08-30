# ServeOS

Multi-tenant SaaS commerce & operations platform for SMBs in Egypt and Saudi Arabia. Bridges walk-in counter POS and online ordering into a single unified tenant-isolated data store.

> **📖 Full documentation lives in [`docs/`](docs/README.md).**

## Surfaces

| Surface | URL | Purpose |
|---------|-----|---------|
| Storefront PWA | `{slug}.serveos.tech` | Customer-facing installable web store |
| Merchant Dashboard | `app.serveos.tech` | Back-office (catalog, orders, inventory) |
| Admin Console | `admin.serveos.tech` | Platform administration |
| Marketing Site | `www.serveos.tech` | Public landing & pricing |
| Desktop POS | `apps/pos` (Electron) | Counter sales, shifts, cash drawer |

## Quick Start

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
# Create .env.local and .env.test — see docs/getting-started/onboarding.md
npm run db:migrate && npm run db:migrate:test
npm run db:seed
npm run dev
```

👉 **Full setup guide:** [docs/getting-started/onboarding.md](docs/getting-started/onboarding.md)

## Testing

```bash
npm run test        # Unit + integration (Vitest, serial, needs serveos_test DB)
npm run test:unit   # Pure logic tests only, no DB
npm run test:e2e    # Playwright E2E (needs seeded dev DB)
npm run pos:test    # Electron POS tests
```

## Documentation

| Document | Description |
|----------|-------------|
| [Project Overview](docs/README.md) | What ServeOS is, who it's for, architecture at a glance |
| [Domain Glossary](CONTEXT.md) | Every domain term defined — the language of the project |
| [Functional Requirements](docs/requirements/functional.md) | Multi-vertical engine & functional module workflows |
| [Non-Functional Requirements](docs/requirements/non-functional.md) | Latency budgets, security, RLS, scalability & compliance |
| [Architecture Overview](docs/architecture/overview.md) | System architecture with C4 diagrams |
| [Sequence & Flow Diagrams](docs/flows/sequence-diagrams.md) | 10 critical end-to-end Mermaid sequence diagrams |
| [State Machines](docs/flows/state-machines.md) | 9 finite state machines & transition matrices |
| [Developer Onboarding](docs/getting-started/onboarding.md) | New developer → productive in < 1 day |
| [Codebase Conventions](docs/getting-started/codebase-conventions.md) | Directory structure, patterns, naming rules |
| [Database Design & ERD](docs/database/erd.md) | Complete data model & Mermaid ERD |
| [Database Tables Reference](docs/database/tables.md) | Exhaustive reference of all 72 tables from Drizzle schema |
| [Master API Reference](docs/api/README.md) | Master API index (64 endpoints & 31 Server Actions) |
| [Testing Strategy & Gaps](docs/testing/testing-strategy-and-gaps.md) | Multi-tier test pyramid, harnesses & roadmap debt |
| [Roadmap](docs/ROADMAP.md) | Spec sequencing + locked decisions (D1–D9) |
| [PRDs](docs/prds/MASTER-PRD.md) | Product requirements registry |
| [Environments](docs/references/environments.md) | Infrastructure map |

## Local Test Users

| Surface | URL | Credentials |
|---------|-----|-------------|
| Platform admin | `admin.serveos.localhost:3000/admin/login` | `admin@serveos.com` / `admin1234` |
| Roma owner | `app.serveos.localhost:3000/login` (slug `roma`) | `owner@roma.com` / `owner1234` |
| Roma manager | same | `manager@roma.com` / `manager1234` |
| Roma staff | same | `staff@roma.com` / `staff1234` |

> These are **local seed credentials only** — not production secrets.
