ALTER TABLE "tenants" ADD COLUMN "tagline" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cuisine" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_featured" boolean DEFAULT false NOT NULL;