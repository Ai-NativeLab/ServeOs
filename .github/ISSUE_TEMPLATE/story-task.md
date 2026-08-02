---
name: Story / Task
about: A delegatable unit of work — carries enough context to be picked up without a conversation
labels: enhancement
---

## Description

<!-- What changes, in one or two paragraphs. Lead with the user-visible or
     system-visible effect, then the mechanism. If it's part of an epic, name it. -->

## Journey

<!-- A named person doing a real thing, before and after this ships.
     If a PRD covers this flow, link its section and reconcile against it:
     > Source: [PRD-00X §Y](../blob/main/docs/prds/...) -->

## Technical & business context

**Business:** <!-- why this matters to the product/plan tiers/operations -->

**Technical:**
<!-- Files to create/modify/test. Interfaces produced (signatures). Patterns to
     mirror (name the reference file). Constraints that must survive implementation. -->

- Modify: `...`
- Create: `...`
- Test: `...`

## Acceptance criteria

1. <!-- observable, testable statements — not restatements of the tasks -->
2. ...
3. `npx vitest run <paths>`, `npx tsc --noEmit`, `npx eslint <paths>` clean.

## Attachments

- **Spec:** <!-- docs/ailab/specs/... or docs/superpowers/specs/... -->
- **Plan:** <!-- docs/ailab/plans/... § Task N, if one exists -->
- **Design:** <!-- Claude-design page / frame, or "none — no UI in this issue" -->
- **Reference code:** <!-- the file(s) whose pattern this should follow -->

## Dependencies

**Depends on:** <!-- #NN, or "nothing — start immediately" -->

**Blocks:** <!-- #NN -->

## Verification

```bash
# The exact commands a reviewer runs to confirm the acceptance criteria.
```
