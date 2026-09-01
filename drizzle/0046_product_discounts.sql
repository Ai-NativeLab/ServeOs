ALTER TABLE "products" ADD COLUMN "sale_price" numeric;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_percent" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_active" boolean DEFAULT false NOT NULL;
