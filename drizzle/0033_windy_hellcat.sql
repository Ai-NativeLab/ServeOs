CREATE TYPE "public"."inventory_item_kind" AS ENUM('ingredient', 'finished_good', 'raw_material');--> statement-breakpoint
CREATE TYPE "public"."product_inventory_link_type" AS ENUM('recipe', 'finished_good');--> statement-breakpoint
CREATE TYPE "public"."stock_count_status" AS ENUM('open', 'committed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."stock_ledger_type" AS ENUM('receive', 'sale_deduction', 'adjustment', 'count', 'transfer', 'waste', 'refund_restock', 'production');--> statement-breakpoint
CREATE TYPE "public"."storage_location_kind" AS ENUM('kitchen', 'retail', 'back_of_house', 'transit');--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"sku" text,
	"kind" "inventory_item_kind" NOT NULL,
	"base_uom" "unit_of_measure" NOT NULL,
	"stock_uom" "unit_of_measure" NOT NULL,
	"stock_to_base" numeric DEFAULT '1' NOT NULL,
	"purchase_uom" "unit_of_measure" NOT NULL,
	"purchase_to_base" numeric DEFAULT '1' NOT NULL,
	"recipe_uom" "unit_of_measure" NOT NULL,
	"recipe_to_base" numeric DEFAULT '1' NOT NULL,
	"is_perishable" boolean DEFAULT false NOT NULL,
	"default_unit_cost" numeric,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_code" text,
	"qty_received" numeric NOT NULL,
	"qty_remaining" numeric NOT NULL,
	"unit_cost" numeric DEFAULT '0' NOT NULL,
	"supplier_id" uuid,
	"po_receipt_line_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expiry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_inventory_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"link_type" "product_inventory_link_type" NOT NULL,
	"recipe_id" uuid,
	"item_id" uuid
);
--> statement-breakpoint
CREATE TABLE "recipe_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" numeric NOT NULL,
	"uom" "unit_of_measure" NOT NULL,
	"waste_pct" numeric DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"yield_qty" numeric DEFAULT '1' NOT NULL,
	"yield_uom" "unit_of_measure" DEFAULT 'each' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"system_qty" numeric NOT NULL,
	"counted_qty" numeric NOT NULL,
	"variance_qty" numeric NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" "stock_count_status" DEFAULT 'open' NOT NULL,
	"started_by_user_id" uuid,
	"committed_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_id" uuid,
	"type" "stock_ledger_type" NOT NULL,
	"qty" numeric NOT NULL,
	"uom" "unit_of_measure" NOT NULL,
	"unit_cost" numeric,
	"ref_type" text,
	"ref_id" text,
	"by_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "storage_location_kind" NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_location_id_storage_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."storage_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_links" ADD CONSTRAINT "product_inventory_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_links" ADD CONSTRAINT "product_inventory_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_links" ADD CONSTRAINT "product_inventory_links_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_links" ADD CONSTRAINT "product_inventory_links_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory_links" ADD CONSTRAINT "product_inventory_links_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_id_stock_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_location_id_storage_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."storage_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_committed_by_user_id_users_id_fk" FOREIGN KEY ("committed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_location_id_storage_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."storage_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_lot_id_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_items_tenant" ON "inventory_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "inventory_lots_fifo" ON "inventory_lots" USING btree ("item_id","location_id","received_at");--> statement-breakpoint
CREATE INDEX "product_inventory_links_product" ON "product_inventory_links" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "recipe_components_recipe" ON "recipe_components" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "recipes_tenant" ON "recipes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_item_loc" ON "stock_ledger" USING btree ("tenant_id","item_id","location_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_ref" ON "stock_ledger" USING btree ("tenant_id","ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "storage_locations_branch_kind" ON "storage_locations" USING btree ("branch_id","kind");--> statement-breakpoint
ALTER TABLE "inventory_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY inventory_items_isolation ON "inventory_items"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "storage_locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_locations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY storage_locations_isolation ON "storage_locations"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "inventory_lots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_lots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY inventory_lots_isolation ON "inventory_lots"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "stock_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stock_ledger_isolation ON "stock_ledger"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "stock_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_counts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stock_counts_isolation ON "stock_counts"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "stock_count_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_count_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stock_count_lines_isolation ON "stock_count_lines"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "product_inventory_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_inventory_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY product_inventory_links_isolation ON "product_inventory_links"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "recipes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recipes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY recipes_isolation ON "recipes"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "recipe_components" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recipe_components" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY recipe_components_isolation ON "recipe_components"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE FUNCTION stock_ledger_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_ledger is append-only: % rejected', TG_OP;
END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER stock_ledger_append_only
  BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_no_mutate();--> statement-breakpoint
CREATE INDEX inventory_lots_available ON "inventory_lots" USING btree ("item_id","location_id","received_at") WHERE qty_remaining > 0;--> statement-breakpoint
ALTER TABLE "product_inventory_links" ADD CONSTRAINT product_inventory_links_xor CHECK (
  (link_type = 'recipe'        AND recipe_id IS NOT NULL AND item_id IS NULL) OR
  (link_type = 'finished_good' AND item_id   IS NOT NULL AND recipe_id IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX pil_product_base ON "product_inventory_links" ("product_id") WHERE variant_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX pil_product_variant ON "product_inventory_links" ("product_id","variant_id") WHERE variant_id IS NOT NULL;