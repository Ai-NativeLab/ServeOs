import { RegisterForm } from "./RegisterForm";

export default function RegisterPage() {
  return (
    <main
      style={{
        background: "#0f172a", minHeight: "100vh", display: "flex",
        alignItems: "center", justifyContent: "center", fontFamily: "system-ui", padding: 24,
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

        <h1 style={{ color: "#fff", fontSize: 22, fontWeight: 700, margin: 0 }}>Create your store</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4, marginBottom: 24 }}>
          Start your free trial. No credit card required.
        </p>

        <RegisterForm />

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
