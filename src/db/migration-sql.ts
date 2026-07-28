/**
 * Reading drizzle's generated migration SQL. Pure — no filesystem, no database.
 *
 * The only interesting part is `partitionEnumAdditions`. Postgres refuses to let
 * a transaction use an enum value that the same transaction added:
 *
 *     ERROR: unsafe use of new value "pending_verification" of enum type invoice_status
 *     HINT:  New enum values must be committed before they can be used.
 *
 * drizzle's migrator runs every pending migration inside ONE transaction, and
 * `0017_gigantic_fantastic_four.sql` adds `invoice_status.pending_verification`
 * and then builds a partial index whose predicate names it. Against an empty
 * database that combination cannot succeed, which is why `ALTER TYPE … ADD
 * VALUE` has to be lifted out and committed on its own first.
 */

export type EnumAddition = {
  /** The original statement, run verbatim so `BEFORE`/`AFTER` placement survives. */
  statement: string;
  type: string;
  value: string;
};

/**
 * Only `ADD VALUE` carries the same-transaction restriction, so the match is
 * deliberately narrow: any other `ALTER TYPE` stays with the transactional
 * statements where it belongs.
 */
const ENUM_ADDITION = /^\s*ALTER\s+TYPE\s+(?:"?public"?\.)?"?(\w+)"?\s+ADD\s+VALUE\s+'((?:[^']|'')*)'/i;

/** Splits a migration file into statements on drizzle's breakpoint marker. */
export function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * Splits statements into the enum additions that must be committed first and
 * the rest, which stay transactional. Order within each group is preserved —
 * `ADD VALUE … BEFORE 'x'` positions a label relative to the ones already
 * there, so resequencing them would change the resulting enum.
 */
export function partitionEnumAdditions(statements: string[]): {
  enumAdditions: EnumAddition[];
  rest: string[];
} {
  const enumAdditions: EnumAddition[] = [];
  const rest: string[] = [];

  for (const statement of statements) {
    const match = ENUM_ADDITION.exec(statement);
    if (match) {
      enumAdditions.push({ statement, type: match[1], value: match[2].replace(/''/g, "'") });
    } else {
      rest.push(statement);
    }
  }

  return { enumAdditions, rest };
}
