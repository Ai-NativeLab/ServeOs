ALTER TABLE "customers" ADD COLUMN "trade_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "trade_discount_percent" numeric;