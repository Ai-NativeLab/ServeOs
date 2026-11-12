DROP INDEX "eta_submissions_order";--> statement-breakpoint
DROP INDEX "eta_submissions_refund";--> statement-breakpoint
CREATE UNIQUE INDEX "eta_submissions_order" ON "eta_submissions" USING btree ("tenant_id","doc_type","order_id") WHERE "eta_submissions"."order_id" is not null and "eta_submissions"."status" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "eta_submissions_refund" ON "eta_submissions" USING btree ("tenant_id","doc_type","refund_id") WHERE "eta_submissions"."refund_id" is not null and "eta_submissions"."status" <> 'rejected';