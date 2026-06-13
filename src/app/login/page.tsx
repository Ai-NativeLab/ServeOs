import { loginAction } from "./actions";

export default function LoginPage() {
  return (
    <main style={{ padding: 48, maxWidth: 420, fontFamily: "system-ui" }}>
      <h1>Sign in</h1>
      <form action={loginAction} style={{ display: "grid", gap: 12 }}>
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
