import type { RegisterInput, RegistrationErrorCode } from "@/server/onboarding";
import { isValidSlug, SLUG_RULE } from "@/server/onboarding/slug";
import { VERTICAL_IDS, type VerticalId } from "@/server/verticals";

/** The form's "Min. 8 characters" — enforced here, not just shown as a placeholder. */
export const MIN_PASSWORD_LENGTH = 8;

export type RegisterField = "restaurantName" | "slug" | "ownerName" | "email" | "password";

/** What the form re-renders with after a rejected submit. Never the password. */
export type RegisterValues = {
  vertical: VerticalId;
  restaurantName: string;
  slug: string;
  country: "EG" | "SA";
  ownerName: string;
  email: string;
};

export type RegisterState = {
  errors: Partial<Record<RegisterField, string>>;
  values: RegisterValues;
};

export type ParsedRegistration =
  | { ok: true; input: RegisterInput; values: RegisterValues }
  | { ok: false; state: RegisterState };

/**
 * What registerTenant's RegistrationError codes say under the Subdomain field.
 * A Record, so a new code fails the typecheck until it has a message.
 */
export const SLUG_ERROR_MESSAGES: Record<RegistrationErrorCode, string> = {
  invalid_slug: SLUG_RULE,
  reserved_slug: "That subdomain is reserved. Pick another.",
  slug_taken: "That subdomain is taken. Pick another.",
};

/**
 * Reads the register form into a RegisterInput, or into the field errors to
 * show beside it. Rejections are return values, not throws: a throw from the
 * server action is an unhandled 500 that wipes the form.
 *
 * The subdomain is trimmed and lowercased first: phone keyboards capitalise
 * the first letter of a text field, and "Roma" crashing signup is not a
 * reasonable answer to that.
 */
export function parseRegistration(formData: FormData): ParsedRegistration {
  const text = (name: string) => String(formData.get(name) ?? "").trim();
  const rawVertical = text("vertical");
  const values: RegisterValues = {
    vertical: ((VERTICAL_IDS as readonly string[]).includes(rawVertical) ? rawVertical : "restaurant") as VerticalId,
    restaurantName: text("restaurantName"),
    slug: text("slug").toLowerCase(),
    country: text("country") === "SA" ? "SA" : "EG",
    ownerName: text("ownerName"),
    email: text("email").toLowerCase(),
  };
  const password = String(formData.get("password") ?? "");

  const errors: RegisterState["errors"] = {};
  if (!isValidSlug(values.slug)) errors.slug = SLUG_RULE;
  if (password.length < MIN_PASSWORD_LENGTH)
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;

  if (Object.keys(errors).length) return { ok: false, state: { errors, values } };
  return { ok: true, input: { ...values, password }, values };
}
