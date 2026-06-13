import { registerAction } from "./actions";

export default function RegisterPage() {
  return (
    <main style={{ padding: 48, maxWidth: 420, fontFamily: "system-ui" }}>
      <h1>Create your restaurant</h1>
      <form action={registerAction} style={{ display: "grid", gap: 12 }}>
        <input name="restaurantName" placeholder="Restaurant name" required />
        <input name="slug" placeholder="subdomain (e.g. roma)" required />
        <select name="country" defaultValue="EG"><option value="EG">Egypt</option><option value="SA">Saudi Arabia</option></select>
        <input name="ownerName" placeholder="Your name" required />
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Start free trial</button>
      </form>
    </main>
  );
}
