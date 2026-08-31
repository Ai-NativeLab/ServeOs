CREATE TYPE "public"."eta_activation_status" AS ENUM('not_configured', 'pending', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."eta_code_source" AS ENUM('gs1', 'egs');--> statement-breakpoint
CREATE TYPE "public"."eta_doc_type" AS ENUM('e_receipt', 'e_invoice', 'credit_note', 'return_receipt');--> statement-breakpoint
CREATE TYPE "public"."eta_environment" AS ENUM('preprod', 'prod');--> statement-breakpoint
CREATE TYPE "public"."eta_pos_credential_status" AS ENUM('registered', 'active', 'expired', 'retired');--> statement-breakpoint
CREATE TYPE "public"."eta_submission_status" AS ENUM('pending', 'submitted', 'accepted', 'rejected', 'failed');--> statement-breakpoint
CREATE TABLE "eta_device_chains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"last_uuid" text,
	"last_issued_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eta_pos_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"eta_serial" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_1_ref" text NOT NULL,
	"client_secret_2_ref" text NOT NULL,
	"preshared_key_ref" text,
	"pos_os_version" text,
	"pos_model_framework" text,
	"status" "eta_pos_credential_status" DEFAULT 'registered' NOT NULL,
	"activated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eta_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doc_type" "eta_doc_type" NOT NULL,
	"order_id" uuid,
	"refund_id" uuid,
	"status" "eta_submission_status" DEFAULT 'pending' NOT NULL,
	"eta_uuid" text,
	"eta_long_id" text,
	"submission_uuid" text,
	"reference_old_uuid" text,
	"qr_payload" text,
	"hash_or_signature" text,
	"request_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_json" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"submitted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eta_tenant_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"registration_number" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_ref" text NOT NULL,
	"signing_key_ref" text,
	"environment" "eta_environment" DEFAULT 'preprod' NOT NULL,
	"activation_status" "eta_activation_status" DEFAULT 'not_configured' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"code_source" "eta_code_source" NOT NULL,
	"item_code" text NOT NULL,
	"egs_approval_status" text,
	"tax_type" text NOT NULL,
	"tax_sub_type" text,
	"unit_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eta_device_chains" ADD CONSTRAINT "eta_device_chains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_device_chains" ADD CONSTRAINT "eta_device_chains_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_pos_credentials" ADD CONSTRAINT "eta_pos_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_pos_credentials" ADD CONSTRAINT "eta_pos_credentials_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_submissions" ADD CONSTRAINT "eta_submissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_submissions" ADD CONSTRAINT "eta_submissions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_submissions" ADD CONSTRAINT "eta_submissions_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_tenant_config" ADD CONSTRAINT "eta_tenant_config_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_tax_codes" ADD CONSTRAINT "product_tax_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_tax_codes" ADD CONSTRAINT "product_tax_codes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eta_device_chains_device" ON "eta_device_chains" USING btree ("tenant_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eta_pos_credentials_device" ON "eta_pos_credentials" USING btree ("tenant_id","device_id");--> statement-breakpoint
CREATE INDEX "eta_submissions_claim" ON "eta_submissions" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "eta_submissions_order" ON "eta_submissions" USING btree ("tenant_id","doc_type","order_id") WHERE order_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "eta_submissions_refund" ON "eta_submissions" USING btree ("tenant_id","doc_type","refund_id") WHERE refund_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "eta_tenant_config_tenant" ON "eta_tenant_config" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_tax_codes_product" ON "product_tax_codes" USING btree ("tenant_id","product_id");--> statement-breakpoint
ALTER TABLE "eta_device_chains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eta_device_chains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY eta_device_chains_isolation ON "eta_device_chains"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "eta_pos_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eta_pos_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY eta_pos_credentials_isolation ON "eta_pos_credentials"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "eta_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eta_submissions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY eta_submissions_isolation ON "eta_submissions"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "eta_tenant_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eta_tenant_config" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY eta_tenant_config_isolation ON "eta_tenant_config"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "product_tax_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_tax_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY product_tax_codes_isolation ON "product_tax_codes"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);