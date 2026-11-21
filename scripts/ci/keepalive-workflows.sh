#!/usr/bin/env bash
# Keeps this repo's scheduled workflows from being switched off by GitHub (#211).
#
# GitHub disables scheduled workflows in a PUBLIC repository after 60 days with
# no repository activity. In Nov 2026 that silently stopped db-backup (no prod
# backups for 12 days), reorder-check, inventory-backfill and demo-reset, and
# with demo-reset gone Supabase paused the idle QA database (#205).
#
# Re-enabling a workflow through the Actions API resets its inactivity counter
# (what gh-workflow-immortality and keepalive-workflow's API mode rely on), so
# this re-enables every workflow that is `active` or `disabled_inactivity`,
# including keepalive.yml itself. It never pushes a commit: a commit on main is
# a Vercel production deploy and a migration run.
#
# Workflows someone disabled on purpose (`disabled_manually`) are left alone.
# If anything WAS `disabled_inactivity`, it is re-enabled and the run fails, so
# GitHub emails about it — the counter-reset behaviour is undocumented, and a
# red run is how we'd find out it stopped working.
#
# Env:
#   GITHUB_REPOSITORY         owner/repo (set by Actions)
#   GH_TOKEN                  token with actions:write (set by the workflow)
#   DRY_RUN=1                 print decisions, call nothing that writes
#   KEEPALIVE_WORKFLOWS_JSON  read the workflow list from this file instead of
#                             the API (tests)
set -euo pipefail

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo)}"

if [[ -n "${KEEPALIVE_WORKFLOWS_JSON:-}" ]]; then
  rows="$(jq -r '.workflows[] | [.id, .state, .path] | @tsv' "$KEEPALIVE_WORKFLOWS_JSON")"
else
  rows="$(gh api --paginate "repos/$repo/actions/workflows?per_page=100" \
    --jq '.workflows[] | [.id, .state, .path] | @tsv')"
fi

lapsed=()
while IFS=$'\t' read -r id state path; do
  [[ -z "$id" ]] && continue
  case "$state" in
    active | disabled_inactivity)
      if [[ "${DRY_RUN:-}" == "1" ]]; then
        echo "would enable $path ($state)"
      else
        gh api --method PUT "repos/$repo/actions/workflows/$id/enable" --silent
        echo "enabled $path ($state)"
      fi
      if [[ "$state" == "disabled_inactivity" ]]; then lapsed+=("$path"); fi
      ;;
    *)
      echo "skip $path ($state)"
      ;;
  esac
done <<<"$rows"

if ((${#lapsed[@]})); then
  for path in "${lapsed[@]}"; do
    note="check what its schedule missed while it was off"
    [[ "$path" == *db-backup.yml ]] && note="no backups were taken while it was off — dispatch it now"
    echo "::error title=Workflow had lapsed::$path had been disabled for inactivity and is re-enabled; $note."
  done
  exit 1
fi
