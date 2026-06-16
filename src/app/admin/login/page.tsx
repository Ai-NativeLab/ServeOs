import type { CSSProperties } from "react";
import { adminLoginAction } from "./actions";

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

export default async function AdminLoginPage({
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

        <h1 style={{ color: "#fff", fontSize: 22, fontWeight: 700, margin: 0 }}>Platform admin</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4, marginBottom: 24 }}>
          Sign in to the ServeOS admin console
        </p>

        {error && (
          <p style={{ color: "#f87171", fontSize: 13, marginBottom: 16 }}>
            Invalid email or password.
          </p>
        )}

        <form action={adminLoginAction} style={{ display: "grid", gap: 16 }}>
          <label style={{ display: "grid" }}>
            <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Email</span>
            <input name="email" type="email" placeholder="admin@serveos.com" required style={inputStyle} />
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
          Restaurant owner?{" "}
          <a href="/login" style={{ color: "#f97316", textDecoration: "none" }}>
            Sign in here →
          </a>
        </p>
      </div>
    </main>
  );
}
