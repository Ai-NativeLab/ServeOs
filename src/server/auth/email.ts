import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * How a user's email is stored and compared: trimmed and lowercased (#204).
 * "Ahmed@Roma.com " and "ahmed@roma.com" are the same person — at sign-up, on
 * the dashboard and admin logins, at the till, and offline on the POS device.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `column` equals `email`, ignoring case and surrounding spaces. Lowercases the
 * stored side too: accounts created before #204 kept whatever casing was typed,
 * so lowercasing only the input would lock those owners out.
 */
export function emailMatches(column: AnyPgColumn, email: string): SQL {
  return sql`lower(${column}) = ${normalizeEmail(email)}`;
}
