CREATE TABLE "delivery_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"delivery_fee" numeric DEFAULT '0' NOT NULL,
	"min_order_amount" numeric DEFAULT '0' NOT NULL,
	"eta_minutes" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "accepting_orders" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "opening_hours" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_areas" ADD CONSTRAINT "delivery_areas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_areas" ADD CONSTRAINT "delivery_areas_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_areas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_areas" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY delivery_areas_isolation ON "delivery_areas"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
