import { createHash } from "node:crypto";
import type { FiscalDocument } from "./provider";
import { WireDecimal, toWireReceipt, type WireContext } from "./eta-wire";

/**
 * ETA's canonical document serialization, the receipt uuid derived from it,
 * and the QR url that carries it. All pure.
 *
 *   Serialization  https://sdk.invoicing.eta.gov.eg/document-serialization-approach/
 *   UUID + QR      https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/
 *
 * The algorithm exists so that "potential newline symbols or spaces added
 * removed between ... JSON elements are not changing the signature value":
 * only field names and values are hashed, never the JSON punctuation.
 */

/** Every rule the SDK page states, in its own order:
 *
 *  1. "Documents processed recursively, starting from the root element."
 *  2. "All property names are converted to culture invariant uppercase."
 *     `toUpperCase()` (not `toLocaleUpperCase`) is the invariant one in JS.
 *  3. "All property values are taken without any processing, just like those
 *     are in the input document" — 0.0 stays 0.0, never 0 or 0.00. This is
 *     why decimals arrive as `WireDecimal` literals rather than JS numbers.
 *  4. "All property names and simple type values ... are enclosed into double
 *     quotes symbol".
 *  5. "In JSON - entire array serialization result is prefixed with the array
 *     property name and every array element is preceded with the array
 *     property name" — the name appears 1 + n times for n elements.
 *  6. Quote escaping is XML-only: "This is not needed in JSON".
 *
 *  Verified against ETA's published worked example (files/one-doc.json ->
 *  files/one-doc-serialized.json.txt) in serialize.test.ts.
 *
 *  NULL: the page states no rule, and ETA's own examples contain no nulls, so
 *  guessing one would silently change every hash. Callers omit absent optional
 *  fields instead (`./eta-wire` does), and a null here is a loud error.
 */
export function canonicalSerialize(wire: Record<string, unknown>): string {
  return serializeObject(wire, "$");
}

function serializeObject(value: Record<string, unknown>, path: string): string {
  let out = "";
  for (const [name, child] of Object.entries(value)) {
    const upper = name.toUpperCase();
    const childPath = `${path}.${name}`;
    if (Array.isArray(child)) {
      out += `"${upper}"`;
      for (const [index, element] of child.entries()) {
        out += `"${upper}"${serializeValue(element, `${childPath}[${index}]`)}`;
      }
    } else {
      out += `"${upper}"${serializeValue(child, childPath)}`;
    }
  }
  return out;
}

function serializeValue(value: unknown, path: string): string {
  if (value === null || value === undefined) {
    throw new Error(`fiscal: ${path} is null/undefined — ETA publishes no serialization rule for null; omit the property instead`);
  }
  if (value instanceof WireDecimal) return `"${value.literal}"`;
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`fiscal: ${path} is not a finite number`);
    return `"${String(value)}"`;
  }
  if (Array.isArray(value)) {
    throw new Error(`fiscal: ${path} is a nested bare array, which ETA's document schema never uses`);
  }
  if (typeof value === "object") return serializeObject(value as Record<string, unknown>, path);
  throw new Error(`fiscal: ${path} has unsupported type ${typeof value} for the ETA wire format`);
}

/**
 * The JSON request body for a wire document.
 *
 * ETA re-derives the uuid from the document it receives, so the transmitted
 * bytes must carry the same literals `canonicalSerialize` hashed — which
 * `JSON.stringify` cannot do, because it would turn `dec("115.00")` into an
 * object and `Number("115.00")` into `115`. Hence this emitter: decimals go
 * out unquoted and verbatim, everything else is standard JSON, and property
 * order matches the hashed order exactly.
 */
export function stringifyWire(wire: Record<string, unknown>): string {
  return emit(wire, "$");
}

function emit(value: unknown, path: string): string {
  if (value === null || value === undefined) {
    throw new Error(`fiscal: ${path} is null/undefined — omit the property instead`);
  }
  if (value instanceof WireDecimal) return value.literal;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`fiscal: ${path} is not a finite number`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((el, i) => emit(el, `${path}[${i}]`)).join(",")}]`;
  if (typeof value === "object") {
    const body = Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => `${JSON.stringify(key)}:${emit(child, `${path}.${key}`)}`)
      .join(",");
    return `{${body}}`;
  }
  throw new Error(`fiscal: ${path} has unsupported type ${typeof value}`);
}

/**
 * The receipt's uuid: SHA-256 of the canonical serialization, as 64 hex
 * characters. Per the Receipt Issuance FAQ's "How to generate receipt UUID?":
 *
 *   "Make sure to include all key fields in receipt object including UUID of
 *    previous receipt issued by same POS device."
 *   "If receipt type is return then make sure to include referenceUUID of the
 *    receipt in this return object."
 *   "Make sure receipt object has empty receipt UUID which is being generated."
 *   "Serialize and normalize receipt object and flatten all its properties in
 *    one line text."
 *   "Create a hash value of the normalized text using SHA256."
 *   "Convert the hash value from array of 32 bytes to hexadecimal string of 64
 *    characters."
 *
 * NOTE — the one judgement call in this file. ETA says the receipt "has empty
 * receipt UUID" and that serialization flattens "all its properties", so the
 * `uuid` KEY is kept with an empty value: the hashed text contains `"UUID"""`.
 * The core-fields validator's looser phrasing ("a valid hash of the content of
 * the serialized receipt with all content excluding the UUID itself") could
 * also be read as dropping the property entirely, which would produce a
 * different hash. The UUID-generation wording is the more specific of the
 * two, so it is what this implements — but it is the single assumption worth
 * confirming against ETA preprod before going live, and flipping it is the
 * one line below.
 */
export function computeReceiptUuid(wire: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalSerialize(withBlankUuid(wire)), "utf8").digest("hex");
}

/** The document with `header.uuid` blanked, keeping its original key position
 *  (property order is part of the hash). */
function withBlankUuid(wire: Record<string, unknown>): Record<string, unknown> {
  const header = wire.header;
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new Error("fiscal: wire document has no header object — cannot blank its uuid");
  }
  if (!("uuid" in header)) {
    throw new Error("fiscal: wire document header has no uuid property — v1.2 marks it Mandatory");
  }
  return { ...wire, header: { ...(header as Record<string, unknown>), uuid: "" } };
}

/**
 * The printed receipt's QR content. Receipt Issuance FAQ, "QR Code Template":
 *
 *   URL format : {eInvoicingPortalURL}/receipts/search/{UUID}/share/{ReceiptDateAndTime}
 *   Template   : {URL}#Total:{Total},IssuerRIN:{Registration Number}
 *
 * `{ReceiptDateAndTime}` is "the receipt issuance date and time in UTC" — the
 * document's own `dateTimeIssued`, passed through verbatim, as is the total.
 */
export function buildQrUrl(params: { portalBase: string; uuid: string; dateUtc: string; total: string; rin: string }): string {
  const base = params.portalBase.replace(/\/+$/, "");
  return `${base}/receipts/search/${params.uuid}/share/${params.dateUtc}#Total:${params.total},IssuerRIN:${params.rin}`;
}

/**
 * Wire document + uuid + QR url for one fiscal document, in the order the
 * chain requires: map to v1.2 JSON (carrying previousUUID / referenceUUID /
 * referenceOldUUID), hash the blank-uuid form, write the uuid back, then build
 * the QR from that same uuid. Pure — same inputs, same uuid, every time.
 */
export function finalizeReceipt(
  doc: FiscalDocument,
  ctx: WireContext,
  opts: { portalBase: string },
): { wire: Record<string, unknown>; uuid: string; qrUrl: string } {
  const wire = toWireReceipt(doc, ctx);
  const uuid = computeReceiptUuid(wire);

  // Assigning in place keeps `uuid` at its original position in `header`,
  // which is what makes the transmitted document hash back to this same uuid.
  const header = wire.header as Record<string, unknown>;
  header.uuid = uuid;

  return {
    wire,
    uuid,
    qrUrl: buildQrUrl({ portalBase: opts.portalBase, uuid, dateUtc: doc.issuedAt, total: doc.total, rin: ctx.rin }),
  };
}
