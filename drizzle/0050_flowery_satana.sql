ALTER TABLE "eta_submissions" ALTER COLUMN "request_json" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "eta_submissions" ALTER COLUMN "request_json" SET DEFAULT '{}'::json;