// Re-exports every domain's Drizzle schema. Domains append their export here.
export * from "../server/tenancy/schema";
export * from "../server/auth/schema";
export * from "../server/subscription/schema";
export * from "../server/billing/schema";
export * from "../server/onboarding/schema";
export * from "../server/platform/audit.schema";
export * from "../server/branches/schema";
