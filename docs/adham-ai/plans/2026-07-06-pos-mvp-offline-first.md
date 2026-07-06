# POS MVP (Offline-First Desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ailab:subagent-driven-development (recommended) or ailab:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Much of the implementation is delegated to OpenCode via the `opencode-delegate` skill; the orchestrator reviews each task's diff and commits.

**Goal:** Ship a cross-platform (Windows + macOS) Electron POS that takes offline-capable cash orders which sync into the existing `orders` backend and appear in the dashboard + analytics.

**Architecture:** New `apps/pos/` Electron app in an npm-workspaces monorepo. A Vite/React/Tailwind **renderer** talks only to the **main process** over a typed preload IPC bridge; the main process owns a local **SQLite** store (catalog cache + append-only order outbox) and a **sync engine** that calls new **versioned** `/api/pos/v1/*` endpoints in the web app, which funnel into the existing `placeOrder`/`markPaid`.

**Tech Stack:** Electron, Vite, React 19, Tailwind v4, better-sqlite3, Drizzle/Postgres (web backend), Vitest, TypeScript.

## Global Constraints

- Platform: Electron, **Windows + macOS**. Renderer is Vite + React + Tailwind (NOT Next.js — no SSR/server components in the POS).
- Repo: **same repo**, new `apps/pos/`, repo converted to **npm workspaces**. Must not break the existing web app's build, tests, or Vercel deploy.
- Offline-first from v1: local **SQLite** (better-sqlite3) in the Electron **main** process; renderer never touches SQLite or the network directly — only the typed preload bridge.
- POS orders reuse the existing backend: server maps to `placeOrder(tenantId, input)` then `markPaid(tenantId, orderId, userId)`. **Do not modify `placeOrder`/`markPaid` signatures.**
- Order push is **idempotent** via a client-generated `clientOrderId` (UUID), backed by a new `pos_order_receipts` table — never double-charge on retry.
- Device auth: **device token** (opaque) in new `pos_devices` table, bound to `tenantId` + `branchId`; issued by redeeming a short-lived code from `pos_pairing_codes`. Validate via a new `requirePosDevice()`; do not reuse the cookie/session path.
- Sync API is **versioned**: all endpoints under `/api/pos/v1/`.
- Payment v1: **cash only** → mark paid. Receipt v1: on-screen + **OS print dialog** (`window.print()`), no ESC/POS. Fulfillment v1: **pickup** only. Customer v1: name `"Walk-in"`.
- Web backend gate commands (run from repo root): `npx tsc --noEmit`, `npx eslint <files>`, and for backend logic `ENV_FILE=.env.test npm run db:migrate:test` then `npm test -- <file>` (Vitest hits the **test** DB, never `.env.local`/prod).
- POS app gate commands (run from `apps/pos/`): `npm run typecheck` (tsc) and `npm run test` (Vitest, pure-logic only — no Electron runtime in CI).
- New Drizzle migrations: edit schema → `npm run db:generate` → review SQL → `npm run db:migrate` (dev) / `db:migrate:test` (test). Register every new schema file in `src/db/schema.ts`.

---

# Milestone A — Workspace + Electron shell boots

Deliverable: `npm run pos:dev` opens an Electron window rendering a React/Tailwind "POS" screen. Web app untouched and still builds.

### Task A1: Convert repo to npm workspaces and scaffold `apps/pos`

**Files:**
- Modify: `package.json` (root) — add `workspaces`, add `pos:*` scripts.
- Create: `apps/pos/package.json`
- Create: `apps/pos/tsconfig.json`
- Create: `apps/pos/.gitignore`

**Interfaces:**
- Produces: workspace `pos` at `apps/pos`; root scripts `pos:dev`, `pos:build`, `pos:typecheck`, `pos:test`.

- [ ] **Step 1: Add workspaces + scripts to root `package.json`.** Add a top-level `"workspaces": ["apps/*"]` and these scripts (keep all existing scripts unchanged):

```json
"pos:dev": "npm run dev -w pos",
"pos:build": "npm run build -w pos",
"pos:typecheck": "npm run typecheck -w pos",
"pos:test": "npm run test -w pos"
```

- [ ] **Step 2: Create `apps/pos/package.json`.**

```json
{
  "name": "pos",
  "version": "0.1.0",
  "private": true,
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.node.json && vite build && electron-builder",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.node.json",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^11.8.0"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "vite": "^6.0.0",
    "vite-plugin-electron": "^0.29.0",
    "@vitejs/plugin-react": "^4.3.0",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@types/better-sqlite3": "^7.6.11",
    "tailwindcss": "^4.3.2",
    "@tailwindcss/vite": "^4.3.2",
    "vitest": "^4.1.8",
    "typescript": "^5"
  }
}
```

- [ ] **Step 3: Create `apps/pos/tsconfig.json`** (renderer) and `apps/pos/tsconfig.node.json` (main/preload). Renderer:

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext",
    "moduleResolution": "bundler", "jsx": "react-jsx", "strict": true, "noEmit": true,
    "skipLibCheck": true, "esModuleInterop": true, "baseUrl": ".", "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "electron"]
}
```

`tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "CommonJS", "moduleResolution": "node", "strict": true,
    "outDir": "dist-electron", "esModuleInterop": true, "skipLibCheck": true, "types": ["node"]
  },
  "include": ["electron"]
}
```

- [ ] **Step 4: Create `apps/pos/.gitignore`** with:

```
node_modules
dist
dist-electron
release
*.sqlite
```

- [ ] **Step 5: Install and verify the web app is unbroken.**

Run: `npm install` (from repo root), then `npx tsc --noEmit` and `npm run build` (web).
Expected: install succeeds with the `pos` workspace linked; web typecheck/build still pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json apps/pos/package.json apps/pos/tsconfig.json apps/pos/tsconfig.node.json apps/pos/.gitignore
git commit -m "chore(pos): npm workspaces + apps/pos scaffold"
```

### Task A2: Electron main + preload + Vite bootstrap

**Files:**
- Create: `apps/pos/electron/main.ts`
- Create: `apps/pos/electron/preload.ts`
- Create: `apps/pos/vite.config.ts`
- Create: `apps/pos/index.html`

**Interfaces:**
- Consumes: none.
- Produces: an Electron main that creates a `BrowserWindow` loading the Vite dev server (dev) or `dist/index.html` (prod); a minimal preload placeholder (`window.pos` extended in Task C4).

- [ ] **Step 1: `apps/pos/electron/main.ts`** — create the window; load dev URL or built file:

```ts
import { app, BrowserWindow } from "electron";
import path from "node:path";

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else win.loadFile(path.join(__dirname, "../dist/index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
```

- [ ] **Step 2: `apps/pos/electron/preload.ts`** — minimal safe bridge placeholder (extended in Task C4):

```ts
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("pos", {
  ping: () => "pong",
});
```

- [ ] **Step 3: `apps/pos/vite.config.ts`** — React + Tailwind + electron plugin:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: { entry: "electron/main.ts" },
      preload: { input: "electron/preload.ts" },
    }),
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

- [ ] **Step 4: `apps/pos/index.html`**:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>ServeOS POS</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 5: Verify main/preload typecheck.**

Run: `npm run pos:typecheck`
Expected: PASS (renderer `src/main.tsx` arrives in Task A3; if tsc errors only on the missing `src/main.tsx`, proceed — A3 adds it, then re-run).

- [ ] **Step 6: Commit**

```bash
git add apps/pos/electron apps/pos/vite.config.ts apps/pos/index.html
git commit -m "feat(pos): electron main, preload, and vite bootstrap"
```

### Task A3: React + Tailwind renderer that boots in Electron

**Files:**
- Create: `apps/pos/src/main.tsx`
- Create: `apps/pos/src/App.tsx`
- Create: `apps/pos/src/index.css`

**Interfaces:**
- Consumes: `window.pos.ping()` from Task A2 preload.
- Produces: a mounted React app; the visual shell later tasks render into.

- [ ] **Step 1: `apps/pos/src/index.css`** — Tailwind v4 entry reusing the web app's brand tokens. Import Tailwind and re-declare the same CSS custom properties the web app uses (copy the `:root` token block from the web app's `src/app/globals.css` so the POS shares the palette):

```css
@import "tailwindcss";
/* Paste the :root { --background, --foreground, --primary, --card, --ink, ... }
   token block from the web app's src/app/globals.css so buttons/cards match. */
```

- [ ] **Step 2: `apps/pos/src/main.tsx`**:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
```

- [ ] **Step 3: `apps/pos/src/App.tsx`** — a placeholder screen that proves the bridge works:

```tsx
export function App() {
  return (
    <div className="min-h-screen grid place-items-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="font-bold text-3xl">ServeOS POS</h1>
        <p className="text-sm text-muted-foreground mt-2">bridge: {window.pos?.ping?.() ?? "n/a"}</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add a global type for `window.pos`.** Create `apps/pos/src/pos-bridge.d.ts`:

```ts
export {};
declare global {
  interface Window { pos: { ping: () => string } }
}
```

- [ ] **Step 5: Boot the app and verify visually.**

Run: `npm run pos:dev`
Expected: an Electron window opens showing "ServeOS POS" and "bridge: pong". Close it. Then `npm run pos:typecheck` passes.

- [ ] **Step 6: Commit**

```bash
git add apps/pos/src
git commit -m "feat(pos): react + tailwind renderer boots in electron"
```

---

# Milestone B — Backend sync API + pairing (in the web app)

Deliverable: a paired device can pull its branch menu and push a cash order that lands in the dashboard Orders queue; the dashboard has a POS-devices settings page. All under `/api/pos/v1/`.

### Task B1: POS schema (devices, pairing codes, idempotency receipts) + migration

**Files:**
- Create: `src/server/pos/schema.ts`
- Modify: `src/db/schema.ts` (append the re-export)
- Create: migration via `npm run db:generate`

**Interfaces:**
- Produces: tables `pos_devices`, `pos_pairing_codes`, `pos_order_receipts` and their inferred types.

- [ ] **Step 1: `src/server/pos/schema.ts`.**

```ts
import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { orders } from "@/server/ordering/schema";

export const posDevices = pgTable("pos_devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  label: text("label").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [uniqueIndex("pos_devices_token").on(t.token)]);

export const posPairingCodes = pgTable("pos_pairing_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  label: text("label").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("pos_pairing_codes_code").on(t.code)]);

// Idempotency: one row per (device, clientOrderId) → the order it produced.
export const posOrderReceipts = pgTable("pos_order_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  clientOrderId: text("client_order_id").notNull(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  orderNumber: text("order_number").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("pos_order_receipts_device_client").on(t.deviceId, t.clientOrderId)]);

export type PosDevice = typeof posDevices.$inferSelect;
export type PosPairingCode = typeof posPairingCodes.$inferSelect;
export type PosOrderReceipt = typeof posOrderReceipts.$inferSelect;
```

- [ ] **Step 2: Register in `src/db/schema.ts`** — append: `export * from "../server/pos/schema";`

- [ ] **Step 3: Generate + apply the migration.**

Run: `npm run db:generate` (review the emitted `drizzle/00XX_*.sql`), then `npm run db:migrate` and `ENV_FILE=.env.test npm run db:migrate:test`.
Expected: three tables created in dev and test DBs.

- [ ] **Step 4: Commit**

```bash
git add src/server/pos/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(pos): device, pairing-code, and idempotency schema"
```

### Task B2: POS device service + `requirePosDevice`

**Files:**
- Create: `src/server/pos/service.ts`
- Create: `src/server/pos/service.test.ts`
- Create: `src/server/pos/require-device.ts`

**Interfaces:**
- Consumes: `posDevices`, `posPairingCodes` (Task B1); `db` from `@/db/client`.
- Produces:
  - `createPairingCode(tenantId, branchId, label, userId): Promise<{ code: string; expiresAt: Date }>` (code = 8 uppercase alphanumerics, 10-min expiry)
  - `redeemPairingCode(code): Promise<{ deviceToken: string; tenantId: string; branchId: string; branchName: string }>` (throws `PosPairingError` if invalid/expired/used; marks code used; creates a `pos_devices` row with a 64-hex token)
  - `listDevices(tenantId): Promise<PosDevice[]>`; `revokeDevice(tenantId, deviceId): Promise<void>`
  - `resolveDevice(token): Promise<{ deviceId: string; tenantId: string; branchId: string } | null>` (null if missing/revoked)
  - `requirePosDevice(req: Request): Promise<{ deviceId, tenantId, branchId }>` (reads `Authorization: Bearer`, throws `PosAuthError` on failure) in `require-device.ts`

- [ ] **Step 1: Write failing tests** in `src/server/pos/service.test.ts` (needs a seeded tenant+branch; follow the existing test setup used by `src/server/ordering/service.test.ts` for creating a tenant/branch fixture):

```ts
import { describe, it, expect } from "vitest";
import { createPairingCode, redeemPairingCode, resolveDevice, listDevices, revokeDevice } from "./service";
// import the project's test fixture helper for a tenant + branch + user (mirror ordering/service.test.ts setup)

describe("pos pairing", () => {
  it("redeems a fresh code into a working device token", async () => {
    const { tenantId, branchId, userId } = await seedTenantBranchUser();
    const { code } = await createPairingCode(tenantId, branchId, "Front counter", userId);
    const res = await redeemPairingCode(code);
    expect(res.tenantId).toBe(tenantId);
    expect(res.branchId).toBe(branchId);
    const dev = await resolveDevice(res.deviceToken);
    expect(dev?.tenantId).toBe(tenantId);
  });

  it("rejects a reused code", async () => {
    const { tenantId, branchId, userId } = await seedTenantBranchUser();
    const { code } = await createPairingCode(tenantId, branchId, "x", userId);
    await redeemPairingCode(code);
    await expect(redeemPairingCode(code)).rejects.toThrow();
  });

  it("revoked device no longer resolves", async () => {
    const { tenantId, branchId, userId } = await seedTenantBranchUser();
    const { code } = await createPairingCode(tenantId, branchId, "x", userId);
    const { deviceToken } = await redeemPairingCode(code);
    const [dev] = await listDevices(tenantId);
    await revokeDevice(tenantId, dev.id);
    expect(await resolveDevice(deviceToken)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `ENV_FILE=.env.test npm run db:migrate:test && npm test -- src/server/pos/service.test.ts`
Expected: FAIL (functions not implemented).

- [ ] **Step 3: Implement `src/server/pos/service.ts`.** Use `randomBytes` for tokens and a `crypto`-based code generator; enforce expiry/used checks in `redeemPairingCode`; `resolveDevice` filters `revokedAt IS NULL`. Throw a `PosPairingError` (add to a `src/server/pos/errors.ts`) on invalid redemption. `createPairingCode` inserts with `expiresAt = now + 10min`.

- [ ] **Step 4: Implement `src/server/pos/require-device.ts`.**

```ts
import { resolveDevice } from "./service";

export class PosAuthError extends Error {}

export async function requirePosDevice(req: Request): Promise<{ deviceId: string; tenantId: string; branchId: string }> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const device = token ? await resolveDevice(token) : null;
  if (!device) throw new PosAuthError("Invalid or revoked device token");
  return device;
}
```

- [ ] **Step 5: Run tests to verify they pass.**

Run: `npm test -- src/server/pos/service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/pos/service.ts src/server/pos/service.test.ts src/server/pos/require-device.ts src/server/pos/errors.ts
git commit -m "feat(pos): device pairing service and requirePosDevice"
```

### Task B3: `POST /api/pos/v1/pair`

**Files:**
- Create: `src/app/api/pos/v1/pair/route.ts`
- Create: `src/app/api/pos/v1/pair/route.test.ts` (or extend service tests if route testing isn't set up — check for existing `route.test.ts` patterns; if none, verify via the service test + a manual curl and note it)

**Interfaces:**
- Consumes: `redeemPairingCode` (B2).
- Produces: `POST /api/pos/v1/pair` — body `{ code: string }` → `200 { deviceToken, tenantId, branchId, branchName }`; `400` on invalid/expired/used code.

- [ ] **Step 1: Implement the route.**

```ts
import { NextRequest, NextResponse } from "next/server";
import { redeemPairingCode } from "@/server/pos/service";
import { PosPairingError } from "@/server/pos/errors";

export async function POST(req: NextRequest) {
  const { code } = (await req.json()) as { code?: string };
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });
  try {
    const res = await redeemPairingCode(code.trim().toUpperCase());
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof PosPairingError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
```

- [ ] **Step 2: Verify.** Typecheck + lint: `npx tsc --noEmit && npx eslint src/app/api/pos/v1/pair/route.ts`. Expected: clean. (Route behavior is already covered by `redeemPairingCode` tests in B2.)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/pos/v1/pair/route.ts
git commit -m "feat(pos): POST /api/pos/v1/pair endpoint"
```

### Task B4: `GET /api/pos/v1/catalog`

**Files:**
- Create: `src/app/api/pos/v1/catalog/route.ts`

**Interfaces:**
- Consumes: `requirePosDevice` (B2); `getPublishedMenu(tenantId, branchId)` from `@/server/catalog/service` (returns `PublishedMenu` from `@/server/catalog/schema`).
- Produces: `GET /api/pos/v1/catalog` (device-auth) → `200 { menu: PublishedMenu, syncedAt: string }`; `401` on bad token.

- [ ] **Step 1: Implement the route.**

```ts
import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice, PosAuthError } from "@/server/pos/require-device";
import { getPublishedMenu } from "@/server/catalog/service";

export async function GET(req: NextRequest) {
  let device;
  try { device = await requirePosDevice(req); }
  catch (e) { if (e instanceof PosAuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); throw e; }
  const menu = await getPublishedMenu(device.tenantId, device.branchId);
  return NextResponse.json({ menu, syncedAt: new Date().toISOString() });
}
```

- [ ] **Step 2: Verify.** `npx tsc --noEmit && npx eslint src/app/api/pos/v1/catalog/route.ts`. Expected: clean. Manually confirm the `PublishedMenu` shape by reading `src/server/catalog/schema.ts` and noting the fields the POS UI will consume (categories → products → modifierGroups → options, prices, imageUrl).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/pos/v1/catalog/route.ts
git commit -m "feat(pos): GET /api/pos/v1/catalog endpoint"
```

### Task B5: `POST /api/pos/v1/orders` (idempotent → placeOrder + markPaid)

**Files:**
- Create: `src/app/api/pos/v1/orders/route.ts`
- Create: `src/server/pos/submit-order.ts` (service that does the idempotent place+pay)
- Create: `src/server/pos/submit-order.test.ts`

**Interfaces:**
- Consumes: `requirePosDevice` (B2); `placeOrder`, `markPaid`, `PlaceOrderLine` from `@/server/ordering/service`; `posOrderReceipts`, `posDevices` (B1).
- Produces:
  - `submitPosOrder(device: { deviceId, tenantId, branchId, createdByUserId? }, input: { clientOrderId: string; lines: PlaceOrderLine[]; notes?: string }): Promise<{ orderId: string; orderNumber: string; idempotent: boolean }>`
  - `POST /api/pos/v1/orders` — body `{ clientOrderId, lines: {productId, quantity, selectedOptionIds}[], notes? }` → `200 { orderId, orderNumber }`.

- [ ] **Step 1: Write failing test** `src/server/pos/submit-order.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { submitPosOrder } from "./submit-order";
// reuse the tenant/branch/user + a published product fixture (mirror ordering/service.test.ts)

describe("submitPosOrder", () => {
  it("places a cash order and marks it paid", async () => {
    const { device, productId } = await seedDeviceAndProduct();
    const res = await submitPosOrder(device, { clientOrderId: "c-1", lines: [{ productId, quantity: 2, selectedOptionIds: [] }] });
    expect(res.orderNumber).toBeTruthy();
    expect(res.idempotent).toBe(false);
  });

  it("is idempotent on the same clientOrderId", async () => {
    const { device, productId } = await seedDeviceAndProduct();
    const a = await submitPosOrder(device, { clientOrderId: "dup", lines: [{ productId, quantity: 1, selectedOptionIds: [] }] });
    const b = await submitPosOrder(device, { clientOrderId: "dup", lines: [{ productId, quantity: 1, selectedOptionIds: [] }] });
    expect(b.idempotent).toBe(true);
    expect(b.orderId).toBe(a.orderId);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npm test -- src/server/pos/submit-order.test.ts`
Expected: FAIL (not implemented).

- [ ] **Step 3: Implement `src/server/pos/submit-order.ts`.** Logic: look up `pos_order_receipts` by `(deviceId, clientOrderId)`; if found return `{ orderId, orderNumber, idempotent: true }`. Else call `placeOrder(tenantId, { branchId, fulfillmentType: "pickup", customerName: "Walk-in", customerPhone: "", lines })`; if `placeOrder` rejects an empty phone, pass a constant placeholder like `"000000000"` (verify against `placeOrder`'s validation while implementing). Then `markPaid(tenantId, orderId, device.createdByUserId ?? <deviceId>)`. Insert a `pos_order_receipts` row (`orderNumber` stored as string). Return `{ orderId, orderNumber: String(orderNumber), idempotent: false }`.

- [ ] **Step 4: Run to verify it passes.**

Run: `npm test -- src/server/pos/submit-order.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Implement the route `src/app/api/pos/v1/orders/route.ts`** — auth via `requirePosDevice`, parse body, call `submitPosOrder`, return `{ orderId, orderNumber }`; `401` on auth error, `400` on missing `clientOrderId`/empty `lines`.

- [ ] **Step 6: Verify + commit.**

Run: `npx tsc --noEmit && npx eslint src/app/api/pos/v1/orders/route.ts src/server/pos/submit-order.ts`
```bash
git add src/app/api/pos/v1/orders/ src/server/pos/submit-order.ts src/server/pos/submit-order.test.ts
git commit -m "feat(pos): idempotent POST /api/pos/v1/orders funneling into placeOrder"
```

### Task B6: Dashboard "POS devices" settings page

**Files:**
- Create: `src/app/dashboard/settings/pos-devices/page.tsx`
- Create: `src/app/dashboard/settings/pos-devices/actions.ts`
- Modify: the settings tabs list (find where `Business Profile / WhatsApp / Fulfillment / Staff / Billing` tabs are defined — likely `src/app/dashboard/settings/SettingsTabs.tsx` — add a "POS devices" tab)

**Interfaces:**
- Consumes: `createPairingCode`, `listDevices`, `revokeDevice` (B2); `listBranches` from `@/server/branches/service`; `requireTenantManagePermission` (used by other settings pages).
- Produces: a page listing devices with revoke, plus a "Pair a device" form (choose branch + label → shows the generated code + expiry).

- [ ] **Step 1: Implement `actions.ts`** — `generatePairingCodeAction(formData)` (reads `branchId`, `label`; calls `createPairingCode`; `revalidatePath`) and `revokeDeviceAction(deviceId)`; both guarded by `requireTenantManagePermission()` (mirror `settings/profile/actions.ts`).

- [ ] **Step 2: Implement `page.tsx`** — server component: list `listDevices(tenantId)` (show label, branch, lastSeenAt, revoke button via `ConfirmActionButton`), and a `ToastForm` with a branch `<select>` (from `listBranches`) + label input calling `generatePairingCodeAction`. Render the returned code prominently when present. Reuse `Card`, `PageHeader`, `Button`, `Label`, `Input` like other settings pages.

- [ ] **Step 3: Add the tab** to the settings tabs list so it's reachable, matching the existing tab entries.

- [ ] **Step 4: Verify + commit.**

Run: `npx tsc --noEmit && npx eslint src/app/dashboard/settings/pos-devices/`
```bash
git add src/app/dashboard/settings/pos-devices/ src/app/dashboard/settings/SettingsTabs.tsx
git commit -m "feat(dashboard): POS devices settings — pair and revoke"
```

---

# Milestone C — Local SQLite store + sync engine (in `apps/pos`)

Deliverable: the main process persists catalog + an order outbox in SQLite and exposes a typed bridge (`window.pos`) to pair, read the menu, queue an order, and observe sync state; the sync engine is unit-tested.

### Task C1: SQLite store in the main process

**Files:**
- Create: `apps/pos/electron/db.ts`
- Create: `apps/pos/electron/store.ts`
- Create: `apps/pos/electron/store.test.ts`

**Interfaces:**
- Produces:
  - `openDb(path: string): Database` (creates tables if absent: `catalog_cache(id INTEGER PK, json TEXT, synced_at TEXT)`, `order_outbox(client_order_id TEXT PK, draft_json TEXT, status TEXT, order_number TEXT, error TEXT, created_at TEXT, updated_at TEXT)`, `device(id INTEGER PK CHECK(id=1), token TEXT, tenant_id TEXT, branch_id TEXT, branch_name TEXT)`)
  - `Store` class over a `Database` with: `saveCatalog(json, syncedAt)`, `getCatalog(): { json: string; syncedAt: string } | null`, `enqueueOrder(clientOrderId, draftJson)`, `pendingOrders(): OutboxRow[]`, `markSynced(clientOrderId, orderNumber)`, `markFailed(clientOrderId, error)`, `allTickets(): OutboxRow[]`, `saveDevice(d)`, `getDevice()`, `clearDevice()`

- [ ] **Step 1: Write failing tests** `apps/pos/electron/store.test.ts` using an in-memory DB (`openDb(":memory:")`):

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { Store } from "./store";

describe("Store", () => {
  it("queues and transitions outbox orders", () => {
    const s = new Store(openDb(":memory:"));
    s.enqueueOrder("c1", JSON.stringify({ lines: [] }));
    expect(s.pendingOrders().map((o) => o.client_order_id)).toEqual(["c1"]);
    s.markSynced("c1", "1042");
    expect(s.pendingOrders()).toHaveLength(0);
    expect(s.allTickets()[0].order_number).toBe("1042");
  });

  it("caches catalog", () => {
    const s = new Store(openDb(":memory:"));
    s.saveCatalog('{"categories":[]}', "2026-07-06T00:00:00Z");
    expect(s.getCatalog()?.json).toContain("categories");
  });
});
```

- [ ] **Step 2: Run to verify fail.** `cd apps/pos && npm run test -- store.test.ts` → FAIL.
- [ ] **Step 3: Implement `db.ts` and `store.ts`** per the interface above (better-sqlite3, `CREATE TABLE IF NOT EXISTS`, prepared statements).
- [ ] **Step 4: Run to verify pass.** `npm run test -- store.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/pos/electron/db.ts apps/pos/electron/store.ts apps/pos/electron/store.test.ts
git commit -m "feat(pos): sqlite store — catalog cache + order outbox"
```

### Task C2: Sync engine (pull catalog, push outbox, state)

**Files:**
- Create: `apps/pos/electron/sync.ts`
- Create: `apps/pos/electron/sync.test.ts`

**Interfaces:**
- Consumes: `Store` (C1).
- Produces:
  - `type SyncState = "online" | "offline" | "syncing"`
  - `type PosApiClient = { getCatalog(): Promise<{ menu: unknown; syncedAt: string }>; postOrder(body: { clientOrderId: string; lines: unknown[]; notes?: string }): Promise<{ orderId: string; orderNumber: string }> }`
  - `class SyncEngine { constructor(store: Store, api: PosApiClient, onState: (s: SyncState, pending: number) => void); pull(): Promise<void>; flush(): Promise<void>; }`
  - `flush()` pushes each pending outbox order via `api.postOrder`; on success `markSynced`; on a network error leaves it `pending` and sets state `offline`; on a non-network (validation) error `markFailed`. `pull()` calls `api.getCatalog` and `saveCatalog`.

- [ ] **Step 1: Write failing tests** with a fake `PosApiClient` (no real network):

```ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { Store } from "./store";
import { SyncEngine } from "./sync";

function makeStore() { return new Store(openDb(":memory:")); }

describe("SyncEngine.flush", () => {
  it("marks an order synced on success", async () => {
    const store = makeStore();
    store.enqueueOrder("c1", JSON.stringify({ lines: [] }));
    const api = { getCatalog: vi.fn(), postOrder: vi.fn().mockResolvedValue({ orderId: "o1", orderNumber: "7" }) };
    const engine = new SyncEngine(store, api as never, () => {});
    await engine.flush();
    expect(store.pendingOrders()).toHaveLength(0);
    expect(store.allTickets()[0].order_number).toBe("7");
  });

  it("keeps order pending on network failure", async () => {
    const store = makeStore();
    store.enqueueOrder("c2", JSON.stringify({ lines: [] }));
    const api = { getCatalog: vi.fn(), postOrder: vi.fn().mockRejectedValue(Object.assign(new Error("offline"), { isNetwork: true })) };
    const engine = new SyncEngine(store, api as never, () => {});
    await engine.flush();
    expect(store.pendingOrders()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify fail.** `npm run test -- sync.test.ts` → FAIL.
- [ ] **Step 3: Implement `sync.ts`.** Distinguish network vs validation errors by an `isNetwork` flag on the thrown error (the real `PosApiClient` in C3 sets it on fetch/`TypeError`). Emit state via `onState` at start (`syncing`), end (`online`/`offline`) with the current `pendingOrders().length`.
- [ ] **Step 4: Run to verify pass.** `npm run test -- sync.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/pos/electron/sync.ts apps/pos/electron/sync.test.ts
git commit -m "feat(pos): offline-first sync engine with outbox flush"
```

### Task C3: Real API client + main-process wiring (pairing, token storage)

**Files:**
- Create: `apps/pos/electron/api.ts`
- Create: `apps/pos/electron/pos-main.ts` (glue: holds Store + SyncEngine + device token, exposes methods used by IPC)
- Modify: `apps/pos/electron/main.ts` (init `pos-main`, register IPC handlers, start a sync interval)

**Interfaces:**
- Consumes: `Store`, `SyncEngine`, `SyncState` (C1/C2); Electron `safeStorage`, `app.getPath("userData")`.
- Produces:
  - `createApiClient(baseUrl: string, getToken: () => string | null): PosApiClient` — real `fetch`; sets `isNetwork = true` on `TypeError`/network failures; sends `Authorization: Bearer <token>`.
  - `PosMain` with: `pair(code): Promise<{ branchName: string }>` (POST /pair, persist device via `safeStorage`), `getMenu(): { json, syncedAt } | null`, `submitOrder(draft): { clientOrderId }` (enqueue + kick a flush), `getTickets()`, `isPaired()`, `onState(cb)`. `baseUrl` comes from an env/config constant (default the deployed web app URL; overridable via `POS_API_URL`).

- [ ] **Step 1: Implement `api.ts`** (fetch wrapper with the `isNetwork` flag and Bearer header).
- [ ] **Step 2: Implement `pos-main.ts`** — open the DB at `path.join(app.getPath("userData"), "pos.sqlite")`, construct `Store`, `SyncEngine`; store/load the device token with `safeStorage.encryptString`/`decryptString`; `submitOrder` generates a `crypto.randomUUID()` `clientOrderId`, enqueues, triggers `flush()`.
- [ ] **Step 3: Wire `main.ts`** — instantiate `PosMain`; `ipcMain.handle("pos:pair", ...)`, `pos:getMenu`, `pos:submitOrder`, `pos:getTickets`, `pos:isPaired`; push sync state to the renderer via `win.webContents.send("pos:state", ...)`; `setInterval(() => posMain.tick(), 15000)` where `tick` pulls catalog + flushes when paired.
- [ ] **Step 4: Verify.** `npm run pos:typecheck` → PASS. (Runtime is exercised in Milestone D.)
- [ ] **Step 5: Commit**

```bash
git add apps/pos/electron/api.ts apps/pos/electron/pos-main.ts apps/pos/electron/main.ts
git commit -m "feat(pos): api client + main-process pairing, storage, sync loop"
```

### Task C4: Typed preload IPC bridge

**Files:**
- Modify: `apps/pos/electron/preload.ts`
- Modify: `apps/pos/src/pos-bridge.d.ts`

**Interfaces:**
- Produces the renderer-facing `window.pos` API:

```ts
interface PosBridge {
  isPaired(): Promise<boolean>;
  pair(code: string): Promise<{ branchName: string }>;
  getMenu(): Promise<{ json: string; syncedAt: string } | null>;
  submitOrder(draft: { lines: { productId: string; quantity: number; selectedOptionIds: string[] }[]; notes?: string }): Promise<{ clientOrderId: string }>;
  getTickets(): Promise<Array<{ client_order_id: string; status: string; order_number: string | null }>>;
  onState(cb: (s: "online" | "offline" | "syncing", pending: number) => void): void;
}
```

- [ ] **Step 1: Implement `preload.ts`** — expose each method via `ipcRenderer.invoke("pos:*", ...)`, and `onState` via `ipcRenderer.on("pos:state", ...)`.
- [ ] **Step 2: Update `pos-bridge.d.ts`** to declare `interface Window { pos: PosBridge }`.
- [ ] **Step 3: Verify + commit.** `npm run pos:typecheck` → PASS.

```bash
git add apps/pos/electron/preload.ts apps/pos/src/pos-bridge.d.ts
git commit -m "feat(pos): typed preload bridge for renderer"
```

---

# Milestone D — Order-entry UI + receipt (in `apps/pos`)

Deliverable: pair a device, build an order with modifiers, charge cash, print a receipt, and see the ticket sync — all in the Electron app.

### Task D1: Pairing screen + paired/unpaired routing

**Files:**
- Create: `apps/pos/src/screens/PairScreen.tsx`
- Modify: `apps/pos/src/App.tsx` (route on `isPaired()`)

**Interfaces:**
- Consumes: `window.pos.isPaired`, `window.pos.pair` (C4).
- Produces: shows `PairScreen` until paired, then the order-entry screen (D2).

- [ ] **Step 1: Implement `PairScreen`** — an input for the 8-char code + "Pair" button calling `window.pos.pair(code)`; on success set paired state; show the error message on failure.
- [ ] **Step 2: Update `App.tsx`** — on mount call `isPaired()`; render `PairScreen` or `<OrderScreen/>` accordingly. Use local React state; no router needed.
- [ ] **Step 3: Verify visually + commit.** `npm run pos:dev`, pair using a code generated from the dashboard POS-devices page against a running web backend. (If the backend isn't reachable in this environment, verify the screen renders + `pos:typecheck` passes and note the manual pairing step.)

```bash
git add apps/pos/src/screens/PairScreen.tsx apps/pos/src/App.tsx
git commit -m "feat(pos): device pairing screen"
```

### Task D2: Catalog + cart + order-entry screen

**Files:**
- Create: `apps/pos/src/screens/OrderScreen.tsx`
- Create: `apps/pos/src/order/cart.ts`
- Create: `apps/pos/src/order/cart.test.ts`
- Create: `apps/pos/src/order/menu.ts` (parse the cached catalog JSON into typed categories/products/modifiers matching `PublishedMenu`)

**Interfaces:**
- Consumes: `window.pos.getMenu` (C4); the `PublishedMenu` shape from the web app (mirror its fields in `menu.ts`).
- Produces:
  - `cart.ts`: `type CartLine = { productId: string; quantity: number; selectedOptionIds: string[]; unitPrice: number; name: string }`; `addLine`, `removeLine`, `changeQty`, `cartTotal(lines): number` (base price + selected option price deltas × qty).
  - `OrderScreen`: category tabs, product grid, a modifier sheet for products with groups, a cart panel with qty steppers and total, and a "Charge (cash)" button (wired in D3).

- [ ] **Step 1: Write failing tests** `apps/pos/src/order/cart.test.ts` for `cartTotal` (base only; base + option deltas; quantity multiplier). Provide concrete numbers, e.g. a 10.00 product + a 2.50 option × qty 3 = 37.50.
- [ ] **Step 2: Run to verify fail.** `npm run test -- cart.test.ts` → FAIL.
- [ ] **Step 3: Implement `menu.ts` + `cart.ts`.**
- [ ] **Step 4: Run to verify pass.** `npm run test -- cart.test.ts` → PASS.
- [ ] **Step 5: Implement `OrderScreen.tsx`** consuming `getMenu()` → `menu.ts`, rendering the grid/tabs/modifier sheet/cart using the shared Tailwind tokens (mirror the storefront's product/modifier UX; OpenCode may reuse patterns from `src/app/_components/storefront/`). Keep styling within the design system.
- [ ] **Step 6: Verify + commit.** `npm run pos:typecheck && npm run test`.

```bash
git add apps/pos/src/screens/OrderScreen.tsx apps/pos/src/order/
git commit -m "feat(pos): catalog + cart + order-entry screen"
```

### Task D3: Charge (cash) → submit → receipt

**Files:**
- Create: `apps/pos/src/screens/Receipt.tsx`
- Modify: `apps/pos/src/screens/OrderScreen.tsx` (wire the charge button)

**Interfaces:**
- Consumes: `window.pos.submitOrder` (C4); `cartTotal` (D2).
- Produces: on "Charge (cash)" → build the draft `{ lines: {productId, quantity, selectedOptionIds}[] }` → `submitOrder` → show `Receipt` (order lines, total, "PAID — CASH", timestamp) → a "Print" button calling `window.print()` → "New order" clears the cart.

- [ ] **Step 1: Implement `Receipt.tsx`** — a print-friendly layout (a `@media print` block or a dedicated print stylesheet so only the receipt prints).
- [ ] **Step 2: Wire the charge flow in `OrderScreen.tsx`** — call `submitOrder`, capture the `clientOrderId`, render `Receipt`, offer Print (`window.print()`) and New order.
- [ ] **Step 3: Verify visually + commit.** `npm run pos:dev`: build an order → Charge → receipt shows → Print opens the OS dialog. `npm run pos:typecheck` passes.

```bash
git add apps/pos/src/screens/Receipt.tsx apps/pos/src/screens/OrderScreen.tsx
git commit -m "feat(pos): cash charge, submit to outbox, printable receipt"
```

### Task D4: Recent tickets + offline banner

**Files:**
- Create: `apps/pos/src/components/SyncBanner.tsx`
- Create: `apps/pos/src/screens/TicketsPanel.tsx`
- Modify: `apps/pos/src/App.tsx` (mount the banner) and `OrderScreen.tsx` (show tickets)

**Interfaces:**
- Consumes: `window.pos.onState`, `window.pos.getTickets` (C4).
- Produces: a persistent banner reflecting `online | offline | syncing` + pending count; a tickets list showing each outbox order's status (synced #, pending, failed).

- [ ] **Step 1: Implement `SyncBanner.tsx`** — subscribe via `onState`; render an offline/syncing indicator when not `online`.
- [ ] **Step 2: Implement `TicketsPanel.tsx`** — poll `getTickets()` (or refresh on state changes); list order number / status.
- [ ] **Step 3: Mount both; verify + commit.** `npm run pos:typecheck`; visually confirm the banner flips when the backend is unreachable.

```bash
git add apps/pos/src/components/SyncBanner.tsx apps/pos/src/screens/TicketsPanel.tsx apps/pos/src/App.tsx apps/pos/src/screens/OrderScreen.tsx
git commit -m "feat(pos): sync banner and recent tickets"
```

---

## Final acceptance (manual, end-to-end)

Run the web backend and the POS app against the **test/dev** DB (never prod):
1. Dashboard → Settings → POS devices → pair a device (branch + label) → copy code.
2. POS app → enter code → lands on order entry with the branch menu.
3. Build an order with a modifier → Charge (cash) → receipt prints → ticket shows synced #.
4. Confirm the order appears in the dashboard **Orders** queue and analytics.
5. Disconnect network → take another order → receipt still prints, ticket shows **pending**, banner shows **offline**.
6. Reconnect → ticket flips to **synced** with a real order number; dashboard shows exactly one new order (idempotent).

---

## Self-Review

**Spec coverage:**
- Electron Win+Mac, `apps/pos/`, npm workspaces → A1–A3. ✅
- Renderer reuses Tailwind tokens/`ui` → A3 Step 1 (token copy), D2/D3 styling. ✅
- Offline-first SQLite in main; renderer only via bridge → C1, C4; enforced by architecture. ✅
- POS orders via existing `placeOrder`/`markPaid`, appear in dashboard → B5, acceptance step 4. ✅
- Device-pairing auth (`pos_devices`/`pos_pairing_codes`), `requirePosDevice` → B1, B2. ✅
- Versioned `/api/pos/v1/*` (pair, catalog, orders) → B3, B4, B5. ✅
- Idempotent order push (`clientOrderId` + `pos_order_receipts`) → B1, B5. ✅
- Cash mark-paid; OS-print receipt; pickup; "Walk-in" → B5, D3. ✅
- Dashboard pairing UI → B6. ✅
- Sync engine + outbox + state → C1, C2; tested C1/C2. ✅
- Testing (backend Vitest on test DB; sync/cart pure-logic Vitest) → B2/B5/C1/C2/D2. ✅
- Auto-update-ready packaging → A2 (electron-builder present); update server explicitly deferred (spec non-goal). ✅

**Placeholder scan:** Scaffolding tasks give exact config/file contents; logic tasks give test code + interfaces. UI tasks specify the component contract and delegate only styling within the design system (not a logic placeholder). The one open detail — the placeholder phone value if `placeOrder` rejects empty — is bounded and resolved against real validation in B5 Step 3.

**Type consistency:** `PosApiClient` (C2) matches `createApiClient` (C3) and the endpoints in B4/B5. `submitOrder` draft shape (`{lines:{productId,quantity,selectedOptionIds}[], notes?}`) is identical across C4 (bridge), C3 (main), and B5 (server). `PlaceOrderLine` reused verbatim from `@/server/ordering/service`. `SyncState` union identical in C2/C3/C4/D4. `clientOrderId` string type consistent across store (C1), main (C3), and server idempotency (B5).
