ALTER TABLE "subscriptions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Existing rows predate the column. A constant default would date every prior
-- subscription to deploy time and render the platform MRR trend a flat line
-- with a step at release; the owning tenant's creation time is the closest
-- available approximation of when its subscription actually began.
UPDATE "subscriptions" s SET "created_at" = t."created_at" FROM "tenants" t WHERE t."id" = s."tenant_id";
