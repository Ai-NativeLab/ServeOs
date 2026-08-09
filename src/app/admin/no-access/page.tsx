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
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[440px] rounded-2xl border bg-card p-8 shadow-card">
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">No platform access</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          You are signed in, but this account is not a ServeOS platform admin. The admin console is
          for platform staff — restaurant accounts manage their store from the dashboard.
        </p>
        <p className="mt-5 text-[13px] text-muted-foreground">
          Running your restaurant?{" "}
          <a href="/dashboard" className="text-primary">
            Go to your dashboard →
          </a>
        </p>
        <p className="mt-2 text-[13px] text-muted-foreground">
          Platform staff?{" "}
          <a href="/admin/login" className="text-primary">
            Sign in with an admin account →
          </a>
        </p>
      </div>
    </main>
  );
}
