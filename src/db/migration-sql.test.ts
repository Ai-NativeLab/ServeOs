import { describe, it, expect } from "vitest";
import { splitStatements, partitionEnumAdditions } from "./migration-sql";

describe("splitStatements", () => {
  it("splits on drizzle's statement breakpoint and trims each statement", () => {
    const sql = `CREATE TABLE "a" ();--> statement-breakpoint\n  ALTER TABLE "a" ADD COLUMN "b" text;\n`;
    expect(splitStatements(sql)).toEqual([`CREATE TABLE "a" ();`, `ALTER TABLE "a" ADD COLUMN "b" text;`]);
  });

  it("drops the empty trailing chunk a file ending in a breakpoint produces", () => {
    expect(splitStatements(`SELECT 1;--> statement-breakpoint\n`)).toEqual(["SELECT 1;"]);
  });

  it("returns a single statement when there is no breakpoint", () => {
    expect(splitStatements(`SELECT 1;`)).toEqual(["SELECT 1;"]);
  });
});

describe("partitionEnumAdditions", () => {
  it("separates enum additions from the statements that may use them", () => {
    const statements = [
      `ALTER TYPE "public"."invoice_status" ADD VALUE 'pending_verification' BEFORE 'paid';`,
      `CREATE TABLE "x" ();`,
    ];
    const { enumAdditions, rest } = partitionEnumAdditions(statements);

    expect(enumAdditions).toEqual([
      { statement: statements[0], type: "invoice_status", value: "pending_verification" },
    ]);
    expect(rest).toEqual([`CREATE TABLE "x" ();`]);
  });

  it("preserves the order enum values were declared in", () => {
    // 0017 adds three payment_method values in sequence; applying them out of
    // order would put the labels in the wrong sort position.
    const statements = [
      `ALTER TYPE "public"."payment_method" ADD VALUE 'instapay';`,
      `ALTER TYPE "public"."payment_method" ADD VALUE 'vodafone_cash';`,
      `ALTER TYPE "public"."payment_method" ADD VALUE 'mobile_wallet';`,
    ];
    const { enumAdditions, rest } = partitionEnumAdditions(statements);

    expect(enumAdditions.map((e) => e.value)).toEqual(["instapay", "vodafone_cash", "mobile_wallet"]);
    expect(rest).toEqual([]);
  });

  it("matches across newlines and irregular whitespace", () => {
    const statements = [`ALTER  TYPE\n  "public"."order_channel"\n  ADD   VALUE 'pos';`];
    const { enumAdditions } = partitionEnumAdditions(statements);

    expect(enumAdditions).toEqual([
      { statement: statements[0], type: "order_channel", value: "pos" },
    ]);
  });

  it("accepts an unqualified, unquoted type name", () => {
    const { enumAdditions } = partitionEnumAdditions([`ALTER TYPE order_channel ADD VALUE 'pos';`]);

    expect(enumAdditions).toEqual([
      { statement: `ALTER TYPE order_channel ADD VALUE 'pos';`, type: "order_channel", value: "pos" },
    ]);
  });

  it("leaves other ALTER TYPE statements in the transactional set", () => {
    // Only ADD VALUE has the same-transaction restriction; renaming an
    // attribute is ordinary transactional DDL and must not be pulled out.
    const statements = [`ALTER TYPE "public"."x" RENAME VALUE 'a' TO 'b';`];
    const { enumAdditions, rest } = partitionEnumAdditions(statements);

    expect(enumAdditions).toEqual([]);
    expect(rest).toEqual(statements);
  });

  it("does not mistake a table column named add_value for an enum addition", () => {
    const statements = [`ALTER TABLE "t" ADD COLUMN "type_add_value" text;`];
    const { enumAdditions, rest } = partitionEnumAdditions(statements);

    expect(enumAdditions).toEqual([]);
    expect(rest).toEqual(statements);
  });
});
