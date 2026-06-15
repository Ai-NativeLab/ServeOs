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
