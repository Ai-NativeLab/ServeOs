#!/usr/bin/env bash
# Swap the DATABASE_URL that `vercel pull` wrote for the one in a GitHub secret,
# after checking both point at the same database host.
#
# Usage (DATABASE_URL in the environment holds the secret's value):
#   bash .github/scripts/use-secret-database-url.sh <pulled env file> <secret name>
#
# Why: when the production job ran, release-migrate died with
# `getaddrinfo EAI_AGAIN hostname: 'base'` (a fragment of "supabase"), although
# the same Vercel value built fine on Vercel's own builder until 20 Aug. Our
# best guess, unconfirmed, is that the value does not survive the
# `vercel pull` -> dotenv file -> `vercel build` round-trip. So the build gets
# DATABASE_URL straight from a GitHub secret, and the pulled line is deleted so
# it cannot compete with it whichever way `vercel build` orders the two.
# Background: https://github.com/Ai-NativeLab/ServeOs/pull/162
#
# The catch: migrations now use the GitHub secret while the deployed app uses
# the Vercel project's DATABASE_URL (--prebuilt does not ship this file). If
# someone rotates one and not the other, migrations and runtime hit different
# databases. The check below fails the job before anything is migrated if the
# hosts differ, or if the usernames differ (Supabase's pooler host is shared by
# every project in a region; the project ref lives in the username). It prints
# hosts only, never a username, URL or password.
set -euo pipefail

env_file="${1:?usage: use-secret-database-url.sh <pulled env file> <secret name>}"
secret_name="${2:?usage: use-secret-database-url.sh <pulled env file> <secret name>}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "::error::${secret_name} secret is empty"
  exit 1
fi

# Host of a postgres URL. Takes what follows the LAST "@" so a password that
# contains "@", "/", "?" or "#" cannot be mistaken for the host.
host_of() {
  local rest="${1#*://}"
  rest="${rest##*@}"
  rest="${rest%%[/?#]*}"
  rest="${rest%%:*}"
  printf '%s' "$rest" | tr '[:upper:]' '[:lower:]'
}

# User of a postgres URL (empty when there is none). Compared, never printed.
user_of() {
  local rest="${1#*://}"
  case "$rest" in *@*) ;; *) return 0 ;; esac
  rest="${rest%@*}"
  printf '%s' "${rest%%:*}"
}

pulled_line="$(grep -m1 '^DATABASE_URL=' "$env_file" || true)"
pulled="${pulled_line#DATABASE_URL=}"
pulled="${pulled#\"}"; pulled="${pulled%\"}"
pulled="${pulled#\'}"; pulled="${pulled%\'}"

if [ -z "$pulled" ]; then
  echo "::error::The Vercel project's DATABASE_URL is missing or empty in ${env_file}, so ${secret_name} cannot be checked against what the deployed app will use. (Vercel does not pull variables marked Sensitive.)"
  exit 1
fi

secret_host="$(host_of "$DATABASE_URL")"
vercel_host="$(host_of "$pulled")"
echo "${secret_name} host:        ${secret_host}"
echo "Vercel DATABASE_URL host: ${vercel_host}"

if [ -z "$secret_host" ] || [ "$secret_host" != "$vercel_host" ]; then
  echo "::error::${secret_name} (host ${secret_host:-<none>}) and the Vercel project's DATABASE_URL (host ${vercel_host:-<none>}) have different hosts. Migrations would run against one database and the app against another. Update whichever is stale; see docs/references/vercel-cli-deploy.md."
  exit 1
fi

if [ "$(user_of "$DATABASE_URL")" != "$(user_of "$pulled")" ]; then
  echo "::error::${secret_name} and the Vercel project's DATABASE_URL share host ${secret_host} but use different usernames, so they may be different databases (on Supabase's pooler the username carries the project ref). Update whichever is stale; see docs/references/vercel-cli-deploy.md."
  exit 1
fi

# Portable in-place delete (works on BSD and GNU).
grep -v '^DATABASE_URL=' "$env_file" > "${env_file}.tmp" || true
mv "${env_file}.tmp" "$env_file"
echo "Removed DATABASE_URL from ${env_file}; the build uses ${secret_name}."
