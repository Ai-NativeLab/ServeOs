ALTER TABLE "products" ADD COLUMN "sale_price" numeric;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_percent" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_discount_percent_range" CHECK ("products"."discount_percent" IS NULL OR ("products"."discount_percent" > 0 AND "products"."discount_percent" < 100));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_sale_price_positive" CHECK ("products"."sale_price" IS NULL OR "products"."sale_price" > 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_discount_window_order" CHECK ("products"."discount_starts_at" IS NULL OR "products"."discount_ends_at" IS NULL OR "products"."discount_ends_at" > "products"."discount_starts_at");