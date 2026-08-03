CREATE TYPE "public"."whatsapp_status_queue_status" AS ENUM('queued', 'sent', 'skipped', 'failed');--> statement-breakpoint
CREATE TABLE "whatsapp_status_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"wa_id" text NOT NULL,
	"body" text NOT NULL,
	"status" "whatsapp_status_queue_status" DEFAULT 'queued' NOT NULL,
	"skip_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wamid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "whatsapp_status_queue" ADD CONSTRAINT "whatsapp_status_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_status_queue" ADD CONSTRAINT "whatsapp_status_queue_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_status_queue_claim" ON "whatsapp_status_queue" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "whatsapp_status_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_status_queue" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY whatsapp_status_queue_isolation ON "whatsapp_status_queue"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
