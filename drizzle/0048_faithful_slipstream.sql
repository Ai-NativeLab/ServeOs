ALTER TABLE "eta_device_chains" DROP CONSTRAINT "eta_device_chains_device_id_pos_devices_id_fk";
--> statement-breakpoint
ALTER TABLE "eta_submissions" DROP CONSTRAINT "eta_submissions_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "eta_submissions" DROP CONSTRAINT "eta_submissions_refund_id_refunds_id_fk";
--> statement-breakpoint
DROP INDEX "eta_submissions_claim";--> statement-breakpoint
ALTER TABLE "eta_device_chains" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "eta_pos_credentials" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "eta_submissions" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "eta_device_chains" ADD CONSTRAINT "eta_device_chains_device_id_pos_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."pos_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_submissions" ADD CONSTRAINT "eta_submissions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_submissions" ADD CONSTRAINT "eta_submissions_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eta_submissions_order_original" ON "eta_submissions" USING btree ("tenant_id","doc_type","order_id") WHERE "eta_submissions"."order_id" is not null and "eta_submissions"."reference_old_uuid" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "eta_submissions_refund_original" ON "eta_submissions" USING btree ("tenant_id","doc_type","refund_id") WHERE "eta_submissions"."refund_id" is not null and "eta_submissions"."reference_old_uuid" is null;--> statement-breakpoint
CREATE INDEX "eta_submissions_order_lookup" ON "eta_submissions" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "eta_submissions_refund_lookup" ON "eta_submissions" USING btree ("tenant_id","refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eta_submissions_eta_uuid" ON "eta_submissions" USING btree ("tenant_id","eta_uuid") WHERE "eta_submissions"."eta_uuid" is not null;--> statement-breakpoint
CREATE INDEX "eta_submissions_claim" ON "eta_submissions" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "eta_submissions" ADD CONSTRAINT "eta_submissions_parent_xor" CHECK ((doc_type in ('e_receipt','e_invoice') and order_id is not null and refund_id is null) or (doc_type in ('credit_note','return_receipt') and refund_id is not null and order_id is null));