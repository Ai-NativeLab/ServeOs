CREATE TABLE "catalog_versions" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"version" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_sync_event_receipts" (
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"result_json" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pos_held_tickets" ADD COLUMN "client_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "client_shift_id" uuid;--> statement-breakpoint
ALTER TABLE "catalog_versions" ADD CONSTRAINT "catalog_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sync_event_receipts" ADD CONSTRAINT "pos_sync_event_receipts_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sync_event_receipts_key" ON "pos_sync_event_receipts" USING btree ("device_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_held_tickets_device_client" ON "pos_held_tickets" USING btree ("device_id","client_ticket_id") WHERE client_ticket_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_device_client" ON "pos_shifts" USING btree ("device_id","client_shift_id") WHERE client_shift_id IS NOT NULL;--> statement-breakpoint
-- Hand-appended: drizzle-kit emits neither FORCE RLS nor policies (see
-- audit_chain_heads in 0018 for the same shape — tenant_id itself is the PK).
-- catalog_versions is tenant data; pos_sync_event_receipts is deliberately
-- NOT enabled here — it is control-plane like pos_order_receipts, keyed by
-- device and written inside a tenant tx that does not yet exist when a
-- replay lands, same reasoning documented on the table in schema.ts.
ALTER TABLE "catalog_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY catalog_versions_isolation ON "catalog_versions"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);