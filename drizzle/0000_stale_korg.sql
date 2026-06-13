CREATE TYPE "public"."tenant_status" AS ENUM('onboarding', 'trial', 'active', 'suspended', 'rejected');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'onboarding' NOT NULL,
	"country" text NOT NULL,
	"currency" text DEFAULT 'EGP' NOT NULL,
	"default_locale" text DEFAULT 'ar' NOT NULL,
	"timezone" text DEFAULT 'Africa/Cairo' NOT NULL,
	"custom_domain" text,
	"logo_url" text,
	"primary_color" text DEFAULT '#0F172A' NOT NULL,
	"theme" text DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_custom_domain_unique" UNIQUE("custom_domain")
);
