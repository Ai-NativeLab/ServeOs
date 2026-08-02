CREATE TYPE "public"."whatsapp_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TABLE "whatsapp_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wa_id" text NOT NULL,
	"direction" "whatsapp_direction" NOT NULL,
	"provider_message_id" text NOT NULL,
	"payload" jsonb,
	"delivery_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_messages_provider_id" ON "whatsapp_messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "whatsapp_messages_tenant_wa" ON "whatsapp_messages" USING btree ("tenant_id","wa_id");--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY whatsapp_messages_isolation ON "whatsapp_messages"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
