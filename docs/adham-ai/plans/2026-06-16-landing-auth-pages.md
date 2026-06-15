# ServeOS Landing & Auth Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use parallel-build (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder marketing homepage and unstyled auth forms with a dark-themed landing page, styled login page, and styled register page; fix post-auth redirects to land on `/dashboard`.

**Architecture:** Four isolated file edits to existing pages. No new routes, no shared components, no new styling system — all UI uses inline styles consistent with the existing codebase. The dev server (`npm run dev`) must be running for visual verification steps.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, inline styles, existing Server Actions.

---

### Task 1: Fix post-auth redirects

**Files:**
- Modify: `src/app/login/actions.ts`
- Modify: `src/app/register/actions.ts`

Both Server Actions currently redirect to `/` after success, which drops the operator on the marketing homepage with no path to the dashboard.

- [ ] **Step 1: Fix login redirect**

Replace the entire contents of `src/app/login/actions.ts`:

```typescript
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import { getTenantBySlug } from "@/server/tenancy";
import { verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";

export async function loginAction(formData: FormData) {
  const slug = String(formData.get("slug")).trim().toLowerCase();
  const email = String(formData.get("email"));
  const password = String(formData.get("password"));

  const tenant = await getTenantBySlug(slug);
  if (!tenant) redirect("/login?error=1");

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenant!.id), eq(users.email, email)))
    .limit(1);
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    redirect("/login?error=1");
  }
  const token = await createSession(user.id, "dashboard");
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/dashboard");
}
```

- [ ] **Step 2: Fix register redirect**

Replace the entire contents of `src/app/register/actions.ts`:

```typescript
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { registerRestaurant } from "@/server/onboarding";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";

export async function registerAction(formData: FormData) {
  const result = await registerRestaurant({
    restaurantName: String(formData.get("restaurantName")),
    slug: String(formData.get("slug")),
    country: String(formData.get("country")) === "SA" ? "SA" : "EG",
    ownerName: String(formData.get("ownerName")),
    email: String(formData.get("email")),
    password: String(formData.get("password")),
  });
  const token = await createSession(result.ownerUserId, "dashboard");
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/dashboard");
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/login/actions.ts src/app/register/actions.ts
git commit -m "fix(auth): redirect to /dashboard after login and register"
```

---

### Task 2: Style the login page

**Files:**
- Modify: `src/app/login/page.tsx`

The form action (`loginAction`) and its redirect behaviour are unchanged — only the page component's JSX is replaced.

- [ ] **Step 1: Replace with styled dark card**

Replace the entire contents of `src/app/login/page.tsx`:

```tsx
import type { CSSProperties } from "react";
import { loginAction } from "./actions";

const inputStyle: CSSProperties = {
  background: "#0f172a",
  border: "1px solid #334155",
  borderRadius: 6,
  padding: "10px 12px",
  color: "#f1f5f9",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main
      style={{
        background: "#0f172a",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui",
        padding: 24,
      }}
    >
      <div style={{ background: "#1e293b", borderRadius: 12, padding: 40, width: "100%", maxWidth: 400 }}>
        <a
          href="/"
          style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28, textDecoration: "none" }}
        >
          <div style={{ width: 24, height: 24, background: "#f97316", borderRadius: 6 }} />
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>ServeOS</span>
        </a>

        <h1 style={{ color: "#fff", fontSize: 22, fontWeight: 700, margin: 0 }}>Welcome back</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4, marginBottom: 24 }}>
          Sign in to your restaurant dashboard
        </p>

        {error && (
          <p style={{ color: "#f87171", fontSize: 13, marginBottom: 16 }}>
            Invalid restaurant, email, or password.
          </p>
        )}

        <form action={loginAction} style={{ display: "grid", gap: 16 }}>
          <label style={{ display: "grid" }}>
            <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Restaurant</span>
            <input name="slug" placeholder="e.g. roma" required style={inputStyle} />
          </label>
          <label style={{ display: "grid" }}>
            <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Email</span>
            <input name="email" type="email" placeholder="you@example.com" required style={inputStyle} />
          </label>
          <label style={{ display: "grid" }}>
            <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Password</span>
            <input name="password" type="password" placeholder="••••••••" required style={inputStyle} />
          </label>
          <button
            type="submit"
            style={{
              marginTop: 8,
              background: "#f97316",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              padding: 11,
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              width: "100%",
            }}
          >
            Sign in
          </button>
        </form>

        <p style={{ marginTop: 20, textAlign: "center", fontSize: 13, color: "#64748b" }}>
          Don{"'"}t have an account?{" "}
          <a href="/register" style={{ color: "#f97316", textDecoration: "none" }}>
            Get started →
          </a>
        </p>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Verify visually**

With `npm run dev` running, open `http://localhost:3000/login`. Confirm:
- Full dark (`#0f172a`) background filling the viewport
- Dark card (`#1e293b`) centred on the page
- Orange ServeOS logo linking back to `/`
- "Welcome back" white heading
- Three labelled input fields with dark backgrounds and subtle borders
- Orange "Sign in" button
- "Get started →" orange link at the bottom

Then open `http://localhost:3000/login?error=1` — a red "Invalid restaurant, email, or password." message should appear above the form.

- [ ] **Step 4: Commit**

```bash
git add src/app/login/page.tsx
git commit -m "feat(auth): style login page with dark card UI"
```

---

### Task 3: Style the register page

**Files:**
- Modify: `src/app/register/page.tsx`

Same dark card pattern as the login page. The form action (`registerAction`) is unchanged.

- [ ] **Step 1: Replace with styled dark card**

Replace the entire contents of `src/app/register/page.tsx`:

```tsx
import type { CSSProperties } from "react";
import { registerAction } from "./actions";

const inputStyle: CSSProperties = {
  background: "#0f172a",
  border: "1px solid #334155",
  borderRadius: 6,
  padding: "10px 12px",
  color: "#f1f5f9",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 12,
  fontWeight: 500,
  marginBottom: 4,
};

export default function RegisterPage() {
  return (
    <main
      style={{
        background: "#0f172a",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui",
        padding: 24,
      }}
    >
      <div style={{ background: "#1e293b", borderRadius: 12, padding: 40, width: "100%", maxWidth: 400 }}>
        <a
          href="/"
          style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28, textDecoration: "none" }}
        >
          <div style={{ width: 24, height: 24, background: "#f97316", borderRadius: 6 }} />
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>ServeOS</span>
        </a>

        <h1 style={{ color: "#fff", fontSize: 22, fontWeight: 700, margin: 0 }}>Create your restaurant</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4, marginBottom: 24 }}>
          Start your free trial. No credit card required.
        </p>

        <form action={registerAction} style={{ display: "grid", gap: 16 }}>
          <label style={{ display: "grid" }}>
            <span style={labelStyle}>Restaurant name</span>
            <input name="restaurantName" placeholder="Roma Ristorante" required style={inputStyle} />
          </label>
          <label style={{ display: "grid" }}>
            <span style={labelStyle}>Subdomain</span>
            <input name="slug" placeholder="roma" required style={inputStyle} />
            <span style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
              Your storefront will be at roma.serveos.com
            </span>
          </label>
          <label style={{ display: "grid" }}>
            <span style={labelStyle}>Country</span>
            <select
              name="country"
              defaultValue="EG"
              style={{ ...inputStyle, appearance: "auto" as CSSProperties["appearance"] }}
            >
              <option value="EG">Egypt</option>
              <option value="SA">Saudi Arabia</option>
            </select>
          </label>
          <label style={{ display: "grid" }}>
            <span style={labelStyle}>Your name</span>
            <input name="ownerName" placeholder="Ahmed Hassan" required style={inputStyle} />
          </label>
          <label style={{ display: "grid" }}>
            <span style={labelStyle}>Email</span>
            <input name="email" type="email" required style={inputStyle} />
          </label>
          <label style={{ display: "grid" }}>
            <span style={labelStyle}>Password</span>
            <input name="password" type="password" placeholder="Min. 8 characters" required style={inputStyle} />
          </label>
          <button
            type="submit"
            style={{
              marginTop: 8,
              background: "#f97316",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              padding: 11,
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              width: "100%",
            }}
          >
            Start free trial
          </button>
        </form>

        <p style={{ marginTop: 20, textAlign: "center", fontSize: 13, color: "#64748b" }}>
          Already have an account?{" "}
          <a href="/login" style={{ color: "#f97316", textDecoration: "none" }}>
            Sign in →
          </a>
        </p>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Verify visually**

Open `http://localhost:3000/register`. Confirm:
- Same dark background and card as the login page
- "Create your restaurant" heading
- Six labelled fields: restaurant name, subdomain, country dropdown, your name, email, password
- Helper text "Your storefront will be at roma.serveos.com" in grey below the subdomain field
- Orange "Start free trial" button
- "Sign in →" orange link at the bottom

- [ ] **Step 4: Commit**

```bash
git add src/app/register/page.tsx
git commit -m "feat(auth): style register page with dark card UI"
```

---

### Task 4: Style the marketing homepage

**Files:**
- Modify: `src/app/page.tsx`

`src/app/page.tsx` has two branches: the storefront branch (triggered when `x-surface === "storefront"` header is set by the middleware) and the marketing fallback (the final `return`). Only the marketing fallback changes — the storefront branch is preserved exactly as-is.

- [ ] **Step 1: Replace the marketing fallback**

In `src/app/page.tsx`, replace only the final `return` block (currently the last 7 lines of the file, after the closing `}` of the `if (surface === "storefront" && slug)` block):

```diff
-  return (
-    <main style={{ padding: 48, fontFamily: "system-ui" }}>
-      <h1>ServeOS</h1>
-      <p>The operating system for restaurants. Online ordering, reservations, and WhatsApp commerce.</p>
-    </main>
-  );
```

Replace with:

```tsx
  return (
    <div style={{ fontFamily: "system-ui", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <nav style={{ background: "#0f172a", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 28, height: 28, background: "#f97316", borderRadius: 6 }} />
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 18 }}>ServeOS</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <a href="/login" style={{ color: "#94a3b8", textDecoration: "none", fontSize: 14 }}>Sign in</a>
          <a href="/register" style={{ background: "#f97316", color: "#fff", padding: "8px 18px", borderRadius: 6, textDecoration: "none", fontSize: 14, fontWeight: 600 }}>Get started</a>
        </div>
      </nav>

      <section style={{ background: "#0f172a", padding: "80px 32px", textAlign: "center", flex: 1 }}>
        <h1 style={{ color: "#fff", fontSize: 40, fontWeight: 800, margin: 0, lineHeight: 1.15 }}>
          Run your restaurant.<br />Not your software.
        </h1>
        <p style={{ color: "#64748b", fontSize: 18, marginTop: 12 }}>
          Menu, orders, WhatsApp commerce — one platform.
        </p>
        <div style={{ marginTop: 32, display: "inline-flex", gap: 12 }}>
          <a href="/register" style={{ background: "#f97316", color: "#fff", padding: "12px 24px", borderRadius: 6, textDecoration: "none", fontSize: 15, fontWeight: 600 }}>Get started free</a>
          <a href="/login" style={{ border: "1px solid #334155", color: "#94a3b8", padding: "12px 24px", borderRadius: 6, textDecoration: "none", fontSize: 15 }}>Sign in →</a>
        </div>
      </section>

      <section style={{ background: "#fff", display: "grid", gridTemplateColumns: "repeat(3,1fr)", borderTop: "1px solid #f1f5f9" }}>
        {[
          { emoji: "🍽️", title: "Menu & Catalog", desc: "Products, categories, branches, and modifiers. Your full menu online." },
          { emoji: "📦", title: "Online Ordering", desc: "Cart, checkout, and real-time order tracking for your customers." },
          { emoji: "💬", title: "WhatsApp Commerce", desc: "Let customers order via WhatsApp chatbot — no app needed." },
        ].map((pillar, i) => (
          <div key={pillar.title} style={{ padding: "32px 24px", borderRight: i < 2 ? "1px solid #f1f5f9" : undefined }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>{pillar.emoji}</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a", marginBottom: 6 }}>{pillar.title}</div>
            <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}>{pillar.desc}</div>
          </div>
        ))}
      </section>

      <footer style={{ background: "#0f172a", padding: "20px 32px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: "#475569", fontSize: 13 }}>© 2026 ServeOS</span>
        <div style={{ display: "flex", gap: 16 }}>
          <a href="#" style={{ color: "#475569", fontSize: 13, textDecoration: "none" }}>Privacy</a>
          <a href="#" style={{ color: "#475569", fontSize: 13, textDecoration: "none" }}>Terms</a>
        </div>
      </footer>
    </div>
  );
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Verify visually**

Open `http://localhost:3000`. Confirm:
- Dark nav bar with ServeOS logo left, "Sign in" text link and "Get started" orange button right
- Dark hero section with "Run your restaurant. Not your software." in large white text
- "Get started free" orange button and "Sign in →" ghost button below the headline
- White feature pillars strip: three columns with emoji, bold title, description; vertical dividers between columns
- Dark footer with "© 2026 ServeOS" left and "Privacy · Terms" right

Click "Sign in" → should reach the styled login page. Click the ServeOS logo on the login page → should return to this homepage.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(marketing): replace placeholder homepage with full landing page"
```

---

## Full smoke test

Run after all 4 tasks are complete. Dev server must be running (`npm run dev`).

1. `http://localhost:3000` → landing page renders with nav, hero, pillars, footer
2. Click "Sign in" in nav → styled `/login` page
3. Submit with any wrong values → `/login?error=1` with red error message above form
4. Submit `slug: roma`, `email: owner@roma.com`, `password: owner1234` → redirects to `/dashboard`
5. `http://localhost:3000` → click "Get started free" → styled `/register` page
6. Fill in new restaurant details (unique slug) → submit → redirects to `/dashboard`
