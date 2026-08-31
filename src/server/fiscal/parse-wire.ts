import { WireDecimal } from "./decimal";

/**
 * The inverse of `stringifyWire` (`./serialize`): ETA wire JSON text back into
 * the object that produced it, decimals intact.
 *
 * WHY THIS EXISTS. A receipt's uuid is the SHA-256 of its serialized document,
 * so the bytes transmitted to ETA must be the bytes that were hashed —
 * property order and decimal literals included. The receipt is finalized at
 * sale time and submitted minutes later by the worker, so those bytes make a
 * round trip through `eta_submissions.request_json` in between. `JSON.parse`
 * alone cannot complete that trip: it turns `114.00` into the JS number `114`,
 * and re-emitting that would produce a document whose hash no longer matches
 * the uuid printed on the customer's receipt. (Property order survives
 * `JSON.parse` for string keys, which is why the column is `json` and not
 * `jsonb` — see its JSDoc.)
 *
 * HOW. `JSON.parse` offers no hook that sees a number's original text, so
 * every bare numeric token is rewritten into a tagged object BEFORE parsing
 * and revived as a `WireDecimal` after. The rewrite is a scan, not a parser:
 * the only place a digit can appear and NOT be a number token is inside a
 * string literal, so quoted spans are copied verbatim and everything else is
 * structure (`{}[],:`), whitespace, or a `true`/`false`/`null` keyword — none
 * of which can begin with a digit or `-`.
 *
 * EVERY number becomes a `WireDecimal`, including integers like `quantity`.
 * That is deliberate and lossless: both `canonicalSerialize` and
 * `stringifyWire` emit a `WireDecimal` and a JS number identically when the
 * literal has no trailing zeros (`"1"` and `1` respectively), so the revived
 * document serializes byte-for-byte like the original. Round-tripping through
 * the emitters — not deep equality of the objects — is the property that
 * matters and the one `parse-wire.test.ts` asserts.
 */

/** Chosen so no ETA document field can collide with it — receipt v1.2 has no
 *  `$` in any property name. */
const DECIMAL_TAG = "$wireDecimal";

/** Wire JSON text -> the wire object, with every numeric literal preserved as
 *  a `WireDecimal` carrying its exact characters. */
export function parseWire(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(tagNumbers(text));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("fiscal: stored wire document is not a JSON object");
  }
  return revive(parsed) as Record<string, unknown>;
}

/** Rewrites every bare numeric token as `{"$wireDecimal":"<literal>"}`,
 *  leaving string contents untouched. */
function tagNumbers(text: string): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      // Copy the whole string literal, honouring backslash escapes so a
      // `\"` never looks like the closing quote.
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === '"') { i++; break; }
        i++;
      }
      out += text.slice(start, i);
      continue;
    }

    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const start = i;
      i++;
      while (i < text.length && isNumberChar(text[i])) i++;
      out += `{${JSON.stringify(DECIMAL_TAG)}:${JSON.stringify(text.slice(start, i))}}`;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** The characters that can continue a JSON number after its first: digits, the
 *  decimal point, and an exponent with its sign. */
function isNumberChar(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || ch === "." || ch === "e" || ch === "E" || ch === "+" || ch === "-";
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const tagged = record[DECIMAL_TAG];
  if (typeof tagged === "string" && Object.keys(record).length === 1) return new WireDecimal(tagged);

  // Object.entries walks insertion order, and JSON.parse inserts in document
  // order — so rebuilding this way keeps the property order the hash depends on.
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) out[key] = revive(child);
  return out;
}
