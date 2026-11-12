ALTER TABLE "refund_lines" ADD COLUMN "vat_amount" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "vat_amount" numeric DEFAULT '0' NOT NULL;