#!/usr/bin/env bash
# Offline tests for keepalive-workflows.sh: feeds it a fixture workflow list
# (KEEPALIVE_WORKFLOWS_JSON) in DRY_RUN mode and checks what it decides.
# Run: bash scripts/ci/keepalive-workflows.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
fixture="$(mktemp)"
trap 'rm -f "$fixture"' EXIT
fails=0

check() { # name, expected exit, needle that must appear (or "!needle" that must not)
  local name="$1" want_exit="$2"; shift 2
  local out code
  out="$(DRY_RUN=1 GITHUB_REPOSITORY=acme/app KEEPALIVE_WORKFLOWS_JSON="$fixture" bash "$here/keepalive-workflows.sh" 2>&1)"
  code=$?
  if [[ "$code" != "$want_exit" ]]; then
    echo "FAIL $name: exit $code, wanted $want_exit"; echo "    ${out//$'\n'/$'\n    '}"; fails=$((fails + 1)); return
  fi
  for needle in "$@"; do
    if [[ "$needle" == !* ]]; then
      if grep -qF -- "${needle:1}" <<<"$out"; then echo "FAIL $name: output has '${needle:1}'"; echo "    ${out//$'\n'/$'\n    '}"; fails=$((fails + 1)); return; fi
    elif ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL $name: output lacks '$needle'"; echo "    ${out//$'\n'/$'\n    '}"; fails=$((fails + 1)); return
    fi
  done
  echo "ok   $name"
}

cat >"$fixture" <<'JSON'
{"workflows":[
  {"id":1,"path":".github/workflows/ci.yml","state":"active"},
  {"id":2,"path":".github/workflows/keepalive.yml","state":"active"}
]}
JSON
check "renews every active workflow, itself included, and passes" 0 \
  "would enable .github/workflows/ci.yml" "would enable .github/workflows/keepalive.yml"

cat >"$fixture" <<'JSON'
{"workflows":[
  {"id":1,"path":".github/workflows/ci.yml","state":"active"},
  {"id":3,"path":".github/workflows/db-backup.yml","state":"disabled_inactivity"}
]}
JSON
check "re-enables a workflow GitHub disabled for inactivity, and fails so someone notices" 1 \
  "would enable .github/workflows/db-backup.yml" "db-backup.yml had been disabled for inactivity"

cat >"$fixture" <<'JSON'
{"workflows":[
  {"id":1,"path":".github/workflows/ci.yml","state":"active"},
  {"id":4,"path":".github/workflows/old-thing.yml","state":"disabled_manually"}
]}
JSON
check "leaves a workflow someone disabled on purpose alone" 0 \
  "skip .github/workflows/old-thing.yml (disabled_manually)" "!would enable .github/workflows/old-thing.yml"

exit "$fails"
