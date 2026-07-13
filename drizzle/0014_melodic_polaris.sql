CREATE TYPE "public"."vertical" AS ENUM('restaurant', 'retail', 'pharmacy', 'timber');--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "vertical" "vertical" DEFAULT 'restaurant' NOT NULL;