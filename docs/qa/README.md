# ServeOS QA test pack

User journeys and test scenarios for every ServeOS surface. A full pass over this
pack is a release sign-off. A single case is quotable in a bug report by a stable
ID.

**Design spec:** [../moai/specs/2026-08-17-qa-test-pack-design.md](../moai/specs/2026-08-17-qa-test-pack-design.md)
**Last verified against code:** 2026-08-17 · **Scope:** what ships today

---

## The files

Read [personas.md](personas.md) first — every `permission` case resolves against
its matrix.

| File | Surface | Journeys | Cases | P1 | Automated |
|---|---|---|---|---|---|
| [personas.md](personas.md) | who the cases are written for | — | — | — | — |
| [01-marketing.md](01-marketing.md) | `www.serveos.tech` | 8 | 40 | 25 | 17 |
| [02-storefront.md](02-storefront.md) | `{slug}.serveos.tech` | 15 | 105 | 84 | 22 |
| [03-dashboard.md](03-dashboard.md) | `app.serveos.tech` | 24 | 148 | 119 | 11 |
| [04-admin-console.md](04-admin-console.md) | `admin.serveos.tech` | 8 | 37 | 29 | 3 |
| [05-pos.md](05-pos.md) | `apps/pos` Electron till | 18 | 101 | 69 | 0 |
| [06-whatsapp.md](06-whatsapp.md) | the tenant's WhatsApp number | 12 | 64 | 51 | 0 |
| [99-cross-cutting.md](99-cross-cutting.md) | all surfaces | 7 | 63 | 53 | 13 |
| **Total** | | **92** | **558** | **430** | **66** |

The design budgeted 420 cases across 85 journeys. The pack came in at **558
across 92** — 33% over, concentrated in four places where each rule is a separate
way to lose money or leak data: POS refunds and drawer closes, storefront
dimensional pricing and prescriptions, dashboard inventory, and cross-cutting
tenant isolation. Nothing was padded; the per-file summaries say where each
overrun went and why.

**`Automated` counts cases an existing test already asserts**, not test files.
The suite is 43 Playwright tests across 11 spec files, and one test often covers
several cases — so 66 tagged cases against 43 tests is expected, not double
counting.

---

## Coverage at a glance

**66 of 558 cases are automated — 12%.** Where that coverage sits is the useful
part:

| Surface | Automated | Comment |
|---|---|---|
| Marketing | 17 / 40 (43%) | best covered; the rebuild in PR #137 brought tests with it |
| Cross-cutting | 13 / 63 (21%) | but 6 of those are responsive; **isolation has 1**, error contract **0** |
| Storefront | 22 / 105 (21%) | browse/cart/checkout covered; accounts, Rx and dimensional have **0** |
| Dashboard | 11 / 148 (7%) | sign-in and nav only; nothing that changes business data |
| Admin console | 3 / 37 (8%) | auth lanes only; nothing that changes platform state |
| **POS** | **0 / 101** | the suite never launches Electron |
| **WhatsApp** | **0 / 64** | 37 modules, unit-tested in isolation, no conversation driven end to end |

### The five biggest automation gaps

In the order worth closing them:

1. **POS money paths** — `POS-TND`, `POS-REF`, `POS-ZRP` (24 cases, all P1). Money is decided here and nothing guards it.
2. **Tenant isolation** — `XC-ISO` (12 cases, 12 P1, 1 automated). RLS is the product's primary security boundary.
3. **WhatsApp conversations** — `WA-START`, `WA-BROWSE`, `WA-CART`, `WA-CONF`. `scripts/whatsapp-sandbox.ts` is already most of a harness.
4. **The audit chain** — `DSH-AUD-002`/`003`. A tamper-evident log that is never verified provides no evidence.
5. **Storefront accounts, Rx and dimensional** — `SF-ACCT`, `SF-RX`, `SF-TIMBER` (29 cases, 0 automated). Two of the three decide legal compliance or the invoice total.

---

## Running a pass

### Setup

```bash
npm run db:seed        # platform admin + roma (restaurant) with owner/manager/staff
npm run demo:seed      # one tenant per vertical, with catalogue and order history
npm run db:migrate     # if the schema has moved since your last pass
npm run dev            # web app
npm run pos:dev        # Electron POS, second terminal
```

Add the `/etc/hosts` entries listed in [personas.md](personas.md) — subdomain
routing does not work without them locally. On QA (`qa.serveos.tech`) the
wildcard domain is real and no hosts file is needed.

**Check your database role is `NOBYPASSRLS` before trusting any `XC-ISO`
result.** A superuser bypasses row-level security silently, so every isolation
case would pass without proving anything.

### Order of execution

Files have real dependencies. Run them in this order:

1. **[04-admin-console.md](04-admin-console.md)** — `ADM-LOGIN`, `ADM-APPR` (approves the tenant `DSH-REG` creates)
2. **[03-dashboard.md](03-dashboard.md)** — `DSH-STAFF` creates the **pharmacist** that two later files need
3. **[02-storefront.md](02-storefront.md)** — needs published catalogues and the pharmacist
4. **[05-pos.md](05-pos.md)** — top to bottom; `POS-PAIR` mints the device, `POS-ZRP` closes the drawer
5. **[06-whatsapp.md](06-whatsapp.md)** — needs a `pro`-or-above plan
6. **[01-marketing.md](01-marketing.md)** — mostly independent; `MKT-DEMO` needs `demo:seed`
7. **[99-cross-cutting.md](99-cross-cutting.md)** — last, by construction

`ADM-SUSP` takes a storefront offline — reactivate before moving on.

### Reading a case

| Column | Meaning |
|---|---|
| `ID` | `<SURFACE>-<JOURNEY>-<NNN>`, append-only and never reused |
| `Type` | `happy` · `edge` · `negative` · `permission` · `i18n` · `responsive` |
| `Pri` | `P1` release blocker (money, data loss, permission or tenancy failure) · `P2` functional defect with a workaround |
| `Auto` | `AUTOMATED (spec › test)` · `PARTIAL (what is left manual)` · `MANUAL` |

Each journey opens with a **narrative** before its table. Read it. It says what
the feature is *for*, and a tester who understands intent finds bugs the table
never listed.

An `AUTOMATED` case still deserves a manual run at least once per release — the
tag means CI asserts it, not that it cannot break in a way CI misses.

---

## Reporting a defect

Quote the case ID. It is the whole point of the ID scheme.

```markdown
**Case:** POS-REF-005
**Environment:** local / QA · commit <sha> · browser or POS build
**Role:** manager (manager@roma.com)
**Tenant:** roma

**Steps** — as per the case, plus anything specific:
1. …

**Expected** (from the case): Refused with `Refund exceeds the amount still refundable`.
**Actual**: 500, and the refund committed. Net paid now -30.00.

**Evidence:** screenshot / response body / relevant log lines
**Severity:** P1 — money left the business incorrectly
```

Two rules that keep the pack honest:

- **Do not reinterpret a case to make it pass.** If the expected result is wrong,
  fix the case in a PR — do not quietly pass it.
- **Check the known-findings register below first.** Several documented gaps have
  cases that are *expected to fail*; re-filing them adds noise.

---

## Known findings register

Everything the pack already knows about. Confirm rather than re-file.

### Defects to fix

| # | Finding | Cases | Severity |
|---|---|---|---|
| F1 | **WhatsApp strands Rx and dimensional orders permanently.** `loadCatalogSlice` filters on `inStock` only, so prescription and dimensional products are listed in chat and addable. `placeOrder` then throws at confirm; effects run inside the turn's transaction so it rolls back, the route rethrows into a 500, and Meta's retry is deduped. The customer taps Confirm and receives silence, forever, with the conversation stuck. The design intends all four exclusions to hand off — delivery and required modifiers do; Rx and dimensional do not. | `WA-GAP-001`–`004` | **P1** |

### Documented gaps — confirm, do not re-file

| # | Finding | Cases |
|---|---|---|
| G1 | **`pos:void` is dead.** Owner and manager hold it, the `line_void`/`order_void` types exist, and `dashboard/analytics/financial` renders a Voids table — but nothing writes a void and the POS has no void UI. The permission and the report are both unreachable. A product question, not a bug. | `POS-GAP-001`, `POS-GAP-002`, `DSH-ANL-004` |
| G2 | **Pairing-code entry is unreachable.** `pos.pair(code)` exists on the bridge and in the main process, and the dashboard mints codes, but no renderer screen calls it — `README.md` documents a flow the UI does not offer. | `POS-GAP-003`, `DSH-POSD-005` |
| G3 | **The POS has no offline mode.** `apps/pos/electron/_offline/` is imported by nothing. `tests/e2e/offline-payment.spec.ts` covers offline *payment methods*, not network loss. A planned offline journey was dropped rather than fabricated. | — (no journey exists) |
| G4 | **`ROADMAP.md` is six specs out of date.** Shifts, Refunds, Audit, Notifications, Inventory and WhatsApp ordering are all shipped while the roadmap lists them as drafting. Payments gateway, reconciliation, purchasing and ZATCA are confirmed unbuilt. Documented in the design spec §3.1; correcting the roadmap is a separate task. | — |
| G5 | **`isTenantServable` has a dead branch.** It accepts `"trial"`, but the tenant status enum is `active \| suspended \| rejected` — trial lives on the subscription. Harmless; noted so nobody relies on it. | `SF-SERVE` preamble |

### Open questions — decide and record when run

These are written as cases but they are questions. Each needs an answer captured,
and several will make either the code or a document wrong.

| # | Question | Case |
|---|---|---|
| Q1 | Is the `advanced_analytics` entitlement actually enforced? `ROADMAP.md` D6 says it is; the nav gate is `menu:manage`. | `DSH-ANL-006` |
| Q2 | Which plan feature flags are genuinely enforced — `custom_theme`, `custom_domain`, `reservations`? A flag with no `requireFeature` behind it promises something the code does not deliver. | `XC-ENT-010` |
| Q3 | What happens to existing branches when a plan is downgraded below the limit? Silently hiding them would be serious. | `XC-ENT-008` |
| Q4 | Can the owner of an unapproved tenant use the dashboard fully? | `DSH-REG-005` |
| Q5 | Does an active POS cashier session survive that user being deactivated? | `DSH-STAFF-005` |
| Q6 | What can a suspended tenant's staff still do — the storefront goes down, but does the dashboard and POS? | `ADM-SUSP-005` |
| Q7 | What state does an order land in when a claimed offline payment is rejected? | `DSH-PAY-003` |
| Q8 | The admin console has no automated responsive coverage — is 360px support expected there? | `XC-RESP-007` |

---

## Sign-off

A release is signed off when:

- [ ] Every **P1** case on every touched surface has been run and passed.
- [ ] Every **P2** case on a surface with changes in this release has been run.
- [ ] `XC-ERR-006` reports **zero** unexplained 500s across the whole pass.
- [ ] `XC-ISO` passes in full, on a `NOBYPASSRLS` role.
- [ ] `DSH-AUD-002` and `DSH-AUD-003` pass — the audit chain verifies clean and detects tampering.
- [ ] Every defect found is filed with its case ID, or added to the register above.
- [ ] Every open question touched in this pass has an answer recorded.

Record each pass below.

| Date | Commit | Environment | Surfaces run | P1 pass rate | Defects filed | Signed off by |
|---|---|---|---|---|---|---|
| | | | | | | |

---

## Maintaining the pack

- **Case IDs are append-only.** A retired case keeps its ID, struck through, so
  an old bug report still resolves. Never renumber.
- **Update the pack in the PR that changes the behaviour.** A case whose expected
  result no longer matches the code is worse than no case — it trains testers to
  ignore failures.
- **Every expected result must be checked against the code path that produces
  it**, not inferred from the UI or from a design doc. Where code and a design
  doc disagree, record both and raise a question. That rule is what produced F1
  and G1–G5.
- **Re-audit a surface for unreachable code before rewriting its file.** Three of
  the five documented gaps were found that way, and one planned journey turned
  out to be unwritable.
