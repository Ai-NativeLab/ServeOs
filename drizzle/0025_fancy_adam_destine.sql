CREATE TYPE "public"."whatsapp_conversation_state" AS ENUM('idle', 'branch', 'categories', 'products', 'variant', 'cart', 'fulfillment', 'contact', 'confirm', 'placed');--> statement-breakpoint
CREATE TABLE "cart_handoff_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token" text NOT NULL,
	"wa_id" text NOT NULL,
	"branch_id" uuid,
	"cart" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wa_id" text NOT NULL,
	"branch_id" uuid,
	"state" "whatsapp_conversation_state" DEFAULT 'idle' NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"cart" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_product_id" uuid,
	"customer_name" text,
	"profile_name" text,
	"last_inbound_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_order_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"confirm_message_id" text NOT NULL,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cart_handoff_tokens" ADD CONSTRAINT "cart_handoff_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_handoff_tokens" ADD CONSTRAINT "cart_handoff_tokens_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_order_receipts" ADD CONSTRAINT "whatsapp_order_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_order_receipts" ADD CONSTRAINT "whatsapp_order_receipts_conversation_id_whatsapp_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."whatsapp_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_order_receipts" ADD CONSTRAINT "whatsapp_order_receipts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_handoff_tokens_token" ON "cart_handoff_tokens" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_conversations_tenant_wa" ON "whatsapp_conversations" USING btree ("tenant_id","wa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_order_receipts_conv_msg" ON "whatsapp_order_receipts" USING btree ("conversation_id","confirm_message_id");--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY whatsapp_conversations_isolation ON "whatsapp_conversations"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "whatsapp_order_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_order_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY whatsapp_order_receipts_isolation ON "whatsapp_order_receipts"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "cart_handoff_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cart_handoff_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY cart_handoff_tokens_isolation ON "cart_handoff_tokens"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
