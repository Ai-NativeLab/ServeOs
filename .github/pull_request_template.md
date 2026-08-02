<!-- Title: conventional commit style — feat(scope): ..., fix(scope): ..., docs: ... -->

## What

<!-- What this PR does and why now. Link the spec/plan it implements. -->

Closes #

## How it was verified

- [ ] `npm run test` — full suite green (CI runs this, but run it locally first)
- [ ] `npx tsc --noEmit` clean
- [ ] `npx eslint <touched paths>` clean
- [ ] New behavior has tests that fail without the change
- [ ] Migrations (if any): `npm run db:migrate && npm run db:migrate:test && npm run db:check` — and RLS blocks hand-appended per `drizzle/0019_*.sql`

## Deviations & notes for the reviewer

<!-- Anything you did differently from the issue/plan and why.
     Anything you deliberately left out, and where it's tracked. -->
