CREATE TYPE "public"."pos_adjustment_type" AS ENUM('line_discount', 'order_discount', 'line_void', 'order_void');--> statement-breakpoint
CREATE TYPE "public"."pos_tender_method" AS ENUM('cash', 'card', 'other');--> statement-breakpoint
ALTER TYPE "public"."order_channel" ADD VALUE 'pos';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'partially_paid' BEFORE 'paid';--> statement-breakpoint
CREATE TABLE "order_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"method" "pos_tender_method" NOT NULL,
	"amount" numeric NOT NULL,
	"tip_amount" numeric DEFAULT '0' NOT NULL,
	"tendered_amount" numeric,
	"change_amount" numeric,
	"reference" text,
	"taken_by_user_id" uuid NOT NULL,
	"shift_id" uuid,
	"client_payment_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_adjustment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid,
	"type" "pos_adjustment_type" NOT NULL,
	"amount" numeric NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"by_user_id" uuid NOT NULL,
	"authorized_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_held_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"draft_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "discount_amount" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cashier_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_amount" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_reason" text;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_taken_by_user_id_users_id_fk" FOREIGN KEY ("taken_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_adjustment_events" ADD CONSTRAINT "pos_adjustment_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_adjustment_events" ADD CONSTRAINT "pos_adjustment_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_adjustment_events" ADD CONSTRAINT "pos_adjustment_events_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_adjustment_events" ADD CONSTRAINT "pos_adjustment_events_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_adjustment_events" ADD CONSTRAINT "pos_adjustment_events_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_held_tickets" ADD CONSTRAINT "pos_held_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_held_tickets" ADD CONSTRAINT "pos_held_tickets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_held_tickets" ADD CONSTRAINT "pos_held_tickets_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_held_tickets" ADD CONSTRAINT "pos_held_tickets_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_payments_order_client" ON "order_payments" USING btree ("order_id","client_payment_id");--> statement-breakpoint
CREATE INDEX "order_payments_order" ON "order_payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "pos_adjustment_events_order" ON "pos_adjustment_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "pos_held_tickets_branch" ON "pos_held_tickets" USING btree ("branch_id");--> statement-breakpoint
ALTER TABLE "order_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY order_payments_isolation ON "order_payments"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "pos_adjustment_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_adjustment_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY pos_adjustment_events_isolation ON "pos_adjustment_events"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "pos_held_tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_held_tickets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY pos_held_tickets_isolation ON "pos_held_tickets"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);