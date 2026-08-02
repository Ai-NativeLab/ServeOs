-- Bootstraps the CI test database.
--
-- Run as a superuser against the `postgres` database of the service container:
--
--     psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -f scripts/ci-db-bootstrap.sql
--
-- The point of this file is the role, not the database. Every tenant-isolation
-- test in this repo asserts that one tenant cannot read another's rows, and a
-- Postgres superuser bypasses row-level security outright. Run the suite as the
-- container's default `postgres` user and those tests pass without exercising a
-- single policy — green CI, untested isolation guarantee. So the tests connect
-- as `serveos_ci`, which is NOSUPERUSER and NOBYPASSRLS. Tables carry FORCE ROW
-- LEVEL SECURITY, so owning them buys no exemption either.
--
-- Idempotent: safe to re-run against a database that already exists.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'serveos_ci') THEN
    CREATE ROLE serveos_ci LOGIN PASSWORD 'serveos_ci';
  END IF;
END
$$;

ALTER ROLE serveos_ci NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

-- CREATE DATABASE cannot run inside a DO block, hence \gexec.
-- serveos_ci owns the database so the migrator can create the `drizzle` schema
-- and the app tables without any grant from the superuser.
SELECT 'CREATE DATABASE serveos_test OWNER serveos_ci'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'serveos_test')\gexec

-- Fail the job rather than let a mis-provisioned role make isolation tests
-- vacuous. Without this, "CI is green" and "RLS works" quietly stop being
-- the same statement.
DO $$
DECLARE
  is_super boolean;
  can_bypass boolean;
BEGIN
  SELECT rolsuper, rolbypassrls INTO is_super, can_bypass
  FROM pg_roles WHERE rolname = 'serveos_ci';

  IF is_super OR can_bypass THEN
    RAISE EXCEPTION
      'serveos_ci is superuser=% bypassrls=% — it must be neither, or every RLS isolation test passes vacuously',
      is_super, can_bypass;
  END IF;
END
$$;
