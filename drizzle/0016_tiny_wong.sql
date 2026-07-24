ALTER TYPE "public"."invoice_status" ADD VALUE 'pending_verification' BEFORE 'paid';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'instapay';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'vodafone_cash';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'mobile_wallet';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'pending_verification' BEFORE 'paid';--> statement-breakpoint
CREATE TABLE "tenant_offline_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"pay_to_detail" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "lemon_squeezy_variant_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider_subscription_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider_customer_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_reference" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_proof_url" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_reference" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_proof_url" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_provider_ref" text;--> statement-breakpoint
ALTER TABLE "tenant_offline_methods" ADD CONSTRAINT "tenant_offline_methods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_offline_methods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_offline_methods" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_offline_methods_isolation ON "tenant_offline_methods"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);