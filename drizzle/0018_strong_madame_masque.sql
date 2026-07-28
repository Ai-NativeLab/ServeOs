CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'system', 'device', 'customer');--> statement-breakpoint
CREATE TABLE "audit_chain_heads" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"head_hash" char(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid,
	"actor_user_id" uuid,
	"actor_type" "audit_actor_type" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seq" bigint NOT NULL,
	"prev_hash" char(64) NOT NULL,
	"entry_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ADD CONSTRAINT "audit_chain_heads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_tenant_seq" ON "audit_events" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_created" ON "audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_entity" ON "audit_events" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_action" ON "audit_events" USING btree ("tenant_id","action");--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY audit_events_isolation ON "audit_events"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_chain_heads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY audit_chain_heads_isolation ON "audit_chain_heads"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE FUNCTION audit_events_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % rejected', TG_OP;
END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutate();