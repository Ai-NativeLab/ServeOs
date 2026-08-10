CREATE TYPE "public"."refund_kind" AS ENUM('full', 'partial');--> statement-breakpoint
CREATE TYPE "public"."refund_method" AS ENUM('cash', 'card', 'store_credit', 'other');--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'refunded';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'partially_refunded';--> statement-breakpoint
CREATE TABLE "refund_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"amount" numeric NOT NULL,
	"restock" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"method" "refund_method" NOT NULL,
	"amount" numeric NOT NULL,
	"reference" text,
	"taken_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" "refund_kind" NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"total_amount" numeric NOT NULL,
	"by_user_id" uuid NOT NULL,
	"authorized_by_user_id" uuid,
	"shift_id" uuid,
	"client_refund_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payments" ADD CONSTRAINT "refund_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payments" ADD CONSTRAINT "refund_payments_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payments" ADD CONSTRAINT "refund_payments_taken_by_user_id_users_id_fk" FOREIGN KEY ("taken_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_lines_refund" ON "refund_lines" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "refund_payments_refund" ON "refund_payments" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "refund_payments_tenant_created" ON "refund_payments" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_order_client" ON "refunds" USING btree ("order_id","client_refund_id");--> statement-breakpoint
CREATE INDEX "refunds_order" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_tenant_branch_created" ON "refunds" USING btree ("tenant_id","branch_id","created_at");--> statement-breakpoint
-- Hand-appended: drizzle-kit emits neither FORCE RLS policies nor these
-- orders indexes. Carried over verbatim from 0033_curvy_tigra when that
-- migration was regenerated to 0037 after Spec 8 took 0033-0036 on main.
-- Dropping them would leave refund tables readable across tenants.
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refunds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY refunds_isolation ON "refunds"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "refund_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY refund_lines_isolation ON "refund_lines"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "refund_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY refund_payments_isolation ON "refund_payments"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE INDEX "orders_tenant_branch_placed" ON "orders" USING btree ("tenant_id","branch_id","placed_at");--> statement-breakpoint
CREATE INDEX "orders_order_number" ON "orders" USING btree ("tenant_id","order_number");--> statement-breakpoint
CREATE INDEX "orders_customer_phone" ON "orders" USING btree ("tenant_id","customer_phone");
