# Master PRD Index

**Project:** ServeOS
**Last updated:** 2026-07-28
**Version:** 1.3

The registry of every PRD in this project. This file is a table of contents, not a content tier — the two content tiers are **high-level** PRDs (initiative scope) and **feature** PRDs (build-ready spec).

## PRD Registry

| ID | Type | Title | Status | Parent | File |
|---|---|---|---|---|---|
| PRD-001 | High-Level | ServeOS | Draft — Pending Review | — | [prd-high-serveos.md](prd-high-serveos.md) |
| PRD-002 | Feature | Cross-Channel Reporting | Draft — Pending Review | PRD-001 | [PRD-002-feature-cross-channel-reporting.md](PRD-002-feature-cross-channel-reporting.md) |
| PRD-003 | High-Level | ZATCA E-Invoicing Compliance (Saudi Arabia) | Draft — Pending Review | PRD-001 | [prd-high-zatca-einvoicing.md](prd-high-zatca-einvoicing.md) |

## PRD Hierarchy

```
PRD-001 — ServeOS (high-level)
├── PRD-002 — Cross-Channel Reporting (feature)  →  Epic #28, issues #29–#43
└── PRD-003 — ZATCA E-Invoicing Compliance (high-level, initiative)
    └── (feature PRDs to follow: device/CSID onboarding, invoice signing,
         submission pipeline, compliant archive)
```

## Conventions

- **High-level PRDs:** `prd-high-[name].md`
- **Feature PRDs:** `PRD-[id]-feature-[name].md` (zero-padded id, e.g. `PRD-002-feature-cross-channel-reporting.md`)
- Every feature PRD names its parent high-level PRD.
- Bump this file's minor version whenever a PRD is added or a registry row changes.

## Related documentation

PRDs describe **what and why**. They sit above the existing technical documentation:

| Layer | Location | Purpose |
|---|---|---|
| PRDs | `docs/prds/` | Product intent, user stories, acceptance criteria |
| Roadmap | `docs/ROADMAP.md` | Spec sequencing, locked decisions, dependency graph |
| Specs | `docs/*/specs/` | Technical solution design per numbered spec |
| Plans | `docs/*/plans/` | Task-by-task implementation plans |
| Issues | GitHub, `spec-10` etc. labels | Delegatable units of work |
