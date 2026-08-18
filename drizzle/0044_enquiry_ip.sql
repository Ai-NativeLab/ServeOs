ALTER TABLE "plan_enquiries" ADD COLUMN "ip" text;--> statement-breakpoint
CREATE INDEX "plan_enquiries_ip_created" ON "plan_enquiries" USING btree ("ip","created_at");