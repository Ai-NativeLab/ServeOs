CREATE UNIQUE INDEX "storage_locations_one_default" ON "storage_locations" USING btree ("branch_id","kind") WHERE is_default;--> statement-breakpoint
-- Append-only triggers must not make a tenant undeletable.
--
-- Both stock_ledger and audit_events cascade from tenants ON DELETE CASCADE, but
-- their BEFORE UPDATE OR DELETE triggers fire on the cascaded row deletes too, so
-- `DELETE FROM tenants WHERE id = ...` aborted with "append-only: DELETE rejected"
-- and the tenant could never be removed — offboarding and fixture cleanup both
-- blocked. (audit_events has carried this since Spec 4; stock_ledger inherited the
-- pattern, so both are fixed together rather than leaving the two inconsistent.)
--
-- pg_trigger_depth() = 0 means the statement was issued directly. A foreign-key
-- cascade runs through internal RI triggers at depth >= 1, so this keeps rejecting
-- every direct UPDATE/DELETE — the actual tamper vector — while letting a tenant
-- delete cascade through. It is not a weakening: reaching the cascade at all
-- requires deleting the tenant row, which destroys the whole tenant regardless.
DROP TRIGGER IF EXISTS stock_ledger_append_only ON stock_ledger;--> statement-breakpoint
CREATE TRIGGER stock_ledger_append_only
  BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW
  WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION stock_ledger_no_mutate();--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW
  WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION audit_events_no_mutate();
