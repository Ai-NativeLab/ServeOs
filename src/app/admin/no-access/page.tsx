import type { CSSProperties } from "react";

const linkStyle: CSSProperties = { color: "#f97316", textDecoration: "none" };

/**
 * Shown when someone is signed in but is not a platform super admin — most
 * often a tenant user whose dashboard session is sent here because the session
 * cookie is scoped to "/".
 *
 * Deliberately not the login form: their credentials are already correct, so a
 * password prompt would be the wrong affordance and would read as a broken
 * login rather than a missing permission.
 */
export default function AdminNoAccessPage() {
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
      <div style={{ background: "#1e293b", borderRadius: 12, padding: 40, width: "100%", maxWidth: 440 }}>
        <h1 style={{ color: "#fff", fontSize: 22, fontWeight: 700, margin: 0 }}>No platform access</h1>
        <p style={{ color: "#94a3b8", fontSize: 14, marginTop: 12, lineHeight: 1.6 }}>
          You are signed in, but this account is not a ServeOS platform admin. The admin console is
          for platform staff — restaurant accounts manage their store from the dashboard.
        </p>
        <p style={{ color: "#64748b", fontSize: 13, marginTop: 20 }}>
          Running your restaurant?{" "}
          <a href="/dashboard" style={linkStyle}>
            Go to your dashboard →
          </a>
        </p>
        <p style={{ color: "#64748b", fontSize: 13, marginTop: 8 }}>
          Platform staff?{" "}
          <a href="/admin/login" style={linkStyle}>
            Sign in with an admin account →
          </a>
        </p>
      </div>
    </main>
  );
}
