ALTER TABLE "orders" ADD COLUMN "customer_email" text;--> statement-breakpoint
ALTER TABLE "eta_submissions" ADD COLUMN "customer_emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "eta_submissions" ADD COLUMN "customer_email_error" text;