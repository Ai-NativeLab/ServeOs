ALTER TABLE "pos_sync_event_receipts" ADD COLUMN "seq" integer;--> statement-breakpoint
CREATE INDEX "pos_sync_event_receipts_device_seq" ON "pos_sync_event_receipts" USING btree ("device_id","seq");