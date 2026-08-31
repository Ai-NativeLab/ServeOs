ALTER TABLE "eta_tenant_config" ADD COLUMN "online_device_id" uuid;--> statement-breakpoint
ALTER TABLE "eta_tenant_config" ADD COLUMN "wire_context_json" jsonb;--> statement-breakpoint
ALTER TABLE "eta_tenant_config" ADD CONSTRAINT "eta_tenant_config_online_device_id_pos_devices_id_fk" FOREIGN KEY ("online_device_id") REFERENCES "public"."pos_devices"("id") ON DELETE restrict ON UPDATE no action;