/**
 * The business buyer a cashier types at the counter when a sale is a B2B one,
 * and the local validation that stops a typo becoming a permanent filing
 * failure hours later.
 *
 * ---------------------------------------------------------------------------
 * WHY SEVEN FIELDS AT THE COUNTER — a deliberate cost, not an oversight.
 *
 * ETA's invoice v1.0 makes the receiver's registration number, registered name
 * and five address components (country, governate, region/city, street,
 * building number) Mandatory for a type-`B` receiver. There is no partial
 * capture: an invoice missing any of them is not a well-formed document, and
 * the only place ServeOS discovers that today is inside the worker, as a
 * permanent `EtaConfigError` on a `failed` row and an owner alert some hours
 * after the customer has left. Asking for all seven while the buyer is still
 * standing at the till is strictly better than that, even though it is slow.
 *
 * THE REAL FIX IS A B2B BUYER DIRECTORY, not a shorter form. Business customers
 * repeat — the same company buys weekly — so the seven fields should be typed
 * ONCE and then chosen from a list by name or registration number. That is a
 * feature this task does not build; it is recorded as a future ticket in the
 * round-2 plan. Until it lands, the form below is the honest cost of filing a
 * tax invoice from a till.
 *
 * ---------------------------------------------------------------------------
 * A HAND-WRITTEN MIRROR OF `buyerSchema`, AND NOTHING COMPILER-CHECKS IT.
 *
 * The authority is `src/server/fiscal/config-service.ts`'s `buyerSchema` (zod)
 * and the `EtaSubmissionBuyer` type in `src/server/fiscal/schema.ts`. Neither
 * can be imported here: this module is bundled into an Electron renderer that
 * has no path into the Next.js server tree, and pulling zod onto the sale path
 * would drag a 1,300-line configuration module (audit writer included) into
 * every till transaction to serve a branch most sales never take.
 *
 * So this is a mirror in the same sense `pos-main.ts`'s `SaleFiscalStatus` is:
 * prose-linked, not type-linked. IF `buyerSchema` GAINS, LOSES OR RESHAPES A
 * FIELD, THIS FILE MUST BE EDITED BY HAND IN THE SAME CHANGE — nothing will
 * fail to compile, and the symptom of drift is a sale that passes here and is
 * refused by `buildInvoice` inside the worker, which is the exact failure this
 * form exists to prevent.
 *
 * ONE HALF OF THE MIRROR IS GUARDED, AND ONLY FROM THE OTHER SIDE. The
 * registration number's pattern is pinned by a static scan in
 * `src/server/fiscal/config-service.test.ts` ("the buyer RIN regex does not
 * drift across the server/till boundary"), which reads THIS FILE as text and
 * asserts `BUYER_RIN_RE`'s declaration carries the same literal `rinSchema`'s
 * does. Breaking either side fails it, with the message naming the other file.
 *
 * It has to live over there and it has to read source rather than import it: a
 * test in THIS package cannot reach `rinSchema` at all, so asserting
 * `BUYER_RIN_RE` against nine digits would only be asserting the regex against
 * itself and would stay green through any change to the server's rule. That is
 * what `buyer.test.ts` used to claim it was doing, and the claim was the
 * problem — a comment asserting a guard exists is what stops anyone writing one.
 *
 * The other rules below are NOT scanned — they are shape, not a literal, and a
 * text scan for them would be noise. They are prose-linked and nothing more.
 *
 * The rules mirrored, one for one:
 *   - `rin`      — `rinSchema`, `/^\d{9}$/` after stripping spaces and `-`
 *                  (`normalizeRin`; a TRN is commonly printed `123-456-789`).
 *                  This one is the scanned half. The buyer's number is checked
 *                  to exactly the shape the SELLER's is; a document naming a
 *                  9-digit issuer and an 8-digit receiver is not well formed.
 *   - `country`  — `"EG"` only (case-insensitive, sent upper-case): a type-`B`
 *                  receiver is an Egyptian business by definition; a foreign
 *                  buyer is ETA receiver type `F`, which ServeOS does not file.
 *   - `name`     — non-empty after trimming (`requiredText`).
 *   - the five mandatory address components — non-empty after trimming.
 *   - the five optional components — carried verbatim, trimmed, omitted when
 *     blank, for the same reason the seller's address carries them: a field the
 *     form cannot set is a field the tenant cannot comply with.
 */

/**
 * ETA's Registration Identification Number: exactly nine digits.
 *
 * THE NAME AND THE ONE-LINE SPELLING ARE BOTH LOAD-BEARING.
 * `config-service.test.ts`'s drift scan reads this file as text and looks for
 * EXACTLY ONE line matching `const BUYER_RIN_RE =` (anchored at the line start,
 * so a mention in a comment is not one), then requires the literal on that same
 * line. It FAILS LOUDLY — it does not silently disarm — if the constant is
 * renamed, declared twice, or wrapped so the pattern sits on the next line. All
 * three are fine changes to make; make them in the scan too, in one commit.
 */
export const BUYER_RIN_RE = /^\d{9}$/;

/** The RIN as typed, minus the separators people copy off a tax card
 *  (`123-456-789`, `123 456 789`). Mirrors the server's `rinSchema` transform. */
export function normalizeRin(value: string): string {
  return value.replace(/[\s-]/g, "");
}

/** The only receiver country a type-`B` (Egyptian business) invoice can name. */
export const BUYER_COUNTRY = "EG";

/** What the form holds while it is being typed — every field a string, because
 *  that is what an `<input>` gives back. */
export type BuyerDraft = {
  rin: string;
  name: string;
  country: string;
  governate: string;
  regionCity: string;
  street: string;
  buildingNumber: string;
  postalCode: string;
  floor: string;
  room: string;
  landmark: string;
  additionalInformation: string;
};

/** The wire shape — `EtaSubmissionBuyer`'s mirror. Optional components are
 *  ABSENT rather than empty strings, so a blank box never files as `""`. */
export type PosSaleBuyer = {
  rin: string;
  name: string;
  address: {
    country: string;
    governate: string;
    regionCity: string;
    street: string;
    buildingNumber: string;
    postalCode?: string;
    floor?: string;
    room?: string;
    landmark?: string;
    additionalInformation?: string;
  };
};

export const EMPTY_BUYER_DRAFT: BuyerDraft = {
  rin: "", name: "",
  country: "EG", governate: "", regionCity: "", street: "", buildingNumber: "",
  postalCode: "", floor: "", room: "", landmark: "", additionalInformation: "",
};

/** The mandatory boxes, in the order the form shows them — one list so the
 *  labels, the validation and the built address cannot fall out of step. */
export const REQUIRED_BUYER_FIELDS = [
  { key: "rin", label: "Tax registration number (TRN)" },
  { key: "name", label: "Registered name" },
  { key: "country", label: "Country" },
  { key: "governate", label: "Governate" },
  { key: "regionCity", label: "Region / city" },
  { key: "street", label: "Street" },
  { key: "buildingNumber", label: "Building number" },
] as const satisfies readonly { key: keyof BuyerDraft; label: string }[];

export const OPTIONAL_BUYER_FIELDS = [
  { key: "postalCode", label: "Postal code" },
  { key: "floor", label: "Floor" },
  { key: "room", label: "Room" },
  { key: "landmark", label: "Landmark" },
  { key: "additionalInformation", label: "Additional information" },
] as const satisfies readonly { key: keyof BuyerDraft; label: string }[];

/** Field-keyed messages, so the form can mark the box that is wrong rather than
 *  printing one sentence about a form with seven inputs in it. Empty ⇒ valid. */
export type BuyerErrors = Partial<Record<keyof BuyerDraft, string>>;

/**
 * Validates a draft against the mirrored rules. Pure — no clock, no I/O — so it
 * is the same function the tests drive directly.
 *
 * The REGISTRATION NUMBER gets the sharper message. It is the one field where a
 * plausible-looking wrong value (eight digits, or nine with a space in it) is
 * both easy to type and impossible to recover from later without reissuing the
 * document, so the form says what shape it wants rather than "required".
 */
export function validateBuyerDraft(draft: BuyerDraft): BuyerErrors {
  const errors: BuyerErrors = {};

  const rin = normalizeRin(draft.rin);
  if (!rin) errors.rin = "Required";
  else if (!BUYER_RIN_RE.test(rin)) errors.rin = "Must be exactly 9 digits";

  for (const field of REQUIRED_BUYER_FIELDS) {
    if (field.key === "rin") continue;
    if (!draft[field.key].trim()) errors[field.key] = "Required";
  }

  const country = draft.country.trim();
  if (country && country.toUpperCase() !== BUYER_COUNTRY) {
    errors.country = "Must be EG — a tax invoice from the till is for an Egyptian business";
  }

  return errors;
}

/**
 * The draft as it goes on the wire, or `null` if it does not validate.
 *
 * REFUSING RATHER THAN COERCING is the point: there is no partial tax invoice,
 * so a builder that silently dropped a blank governate would file a document
 * ETA refuses — the failure this whole module exists to move forward in time.
 */
export function buildPosSaleBuyer(draft: BuyerDraft): PosSaleBuyer | null {
  if (Object.keys(validateBuyerDraft(draft)).length > 0) return null;

  const trimmed = (value: string): string | undefined => {
    const v = value.trim();
    return v === "" ? undefined : v;
  };

  return {
    rin: normalizeRin(draft.rin),
    name: draft.name.trim(),
    address: {
      country: BUYER_COUNTRY,
      governate: draft.governate.trim(),
      regionCity: draft.regionCity.trim(),
      street: draft.street.trim(),
      buildingNumber: draft.buildingNumber.trim(),
      // Spread-omitted rather than set to undefined: the payload is JSON, and an
      // explicit `"postalCode": null` is a different thing to send than a field
      // that is not there.
      ...(trimmed(draft.postalCode) ? { postalCode: draft.postalCode.trim() } : {}),
      ...(trimmed(draft.floor) ? { floor: draft.floor.trim() } : {}),
      ...(trimmed(draft.room) ? { room: draft.room.trim() } : {}),
      ...(trimmed(draft.landmark) ? { landmark: draft.landmark.trim() } : {}),
      ...(trimmed(draft.additionalInformation)
        ? { additionalInformation: draft.additionalInformation.trim() }
        : {}),
    },
  };
}
