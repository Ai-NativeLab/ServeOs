"use client";
import { useActionState, useState } from "react";
import { customerLoginAction, customerRegisterAction } from "./actions";

const input = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
const label = "mb-1 block text-xs font-medium text-muted-foreground";

export function AccountForms() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginState, loginAction, loginPending] = useActionState(customerLoginAction, undefined);
  const [regState, regAction, regPending] = useActionState(customerRegisterAction, undefined);

  return (
    <div className="mx-auto max-w-sm">
      <div className="mb-4 flex rounded-lg bg-secondary p-1">
        {(["login", "register"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={mode === m
              ? "flex-1 rounded-md bg-card px-3 py-1.5 text-sm font-semibold text-ink shadow-sm"
              : "flex-1 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground"}
          >
            {m === "login" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      {mode === "login" ? (
        <form action={loginAction} className="space-y-3">
          <div><label className={label}>Email</label><input name="email" type="email" required className={input} /></div>
          <div><label className={label}>Password</label><input name="password" type="password" required className={input} /></div>
          {loginState?.error && <p className="text-sm text-status-danger-fg">{loginState.error}</p>}
          <button disabled={loginPending} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
            {loginPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : (
        <form action={regAction} className="space-y-3">
          <div><label className={label}>Name</label><input name="name" required className={input} /></div>
          <div><label className={label}>Email</label><input name="email" type="email" required className={input} /></div>
          <div><label className={label}>Phone (optional)</label><input name="phone" className={input} /></div>
          <div><label className={label}>Password (8+ characters)</label><input name="password" type="password" minLength={8} required className={input} /></div>
          {regState?.error && <p className="text-sm text-status-danger-fg">{regState.error}</p>}
          <button disabled={regPending} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
            {regPending ? "Creating…" : "Create account"}
          </button>
        </form>
      )}
    </div>
  );
}
