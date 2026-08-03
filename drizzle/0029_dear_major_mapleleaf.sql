CREATE TYPE "public"."unit_of_measure" AS ENUM('each', 'g', 'kg', 'ml', 'l', 'm', 'm2', 'bf');--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "unit_of_measure" "unit_of_measure";