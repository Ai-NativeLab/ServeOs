CREATE TABLE "plan_enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_key" text NOT NULL,
	"name" text NOT NULL,
	"business_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"locale" text NOT NULL,
	"status" text DEFAULT 'unsent' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "plan_enquiries_email_created" ON "plan_enquiries" USING btree ("email","created_at");
