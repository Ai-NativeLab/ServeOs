import { z } from "zod";

/**
 * The shared field vocabulary. Every form and API boundary should build its
 * schema out of these rather than re-deriving "what is a valid phone number"
 * per action — which is how the codebase ended up with exactly one password
 * rule (customerRegisterAction) and none anywhere else.
 *
 * All messages are user-facing English. The dashboard has no i18n yet; when it
 * gains one these become message keys, which is easier from one module than
 * from thirty inline string literals.
 */

export const PASSWORD_MIN_LENGTH = 8;
/**
 * Not a security limit — a cost limit. scrypt hashes the whole input, so an
 * unbounded password field is a cheap way to make the server do expensive
 * work on every sign-in attempt.
 */
export const PASSWORD_MAX_LENGTH = 200;

export const NAME_MAX_LENGTH = 120;

/**
 * A floor, not a breach corpus.
 *
 * Deliberately NOT composition rules (one upper, one digit, one symbol).
 * NIST SP 800-63B dropped those because they push people towards `Password1!`
 * — predictable to a cracker, annoying to a human. Length plus a blocklist of
 * what people actually type is the better trade. If this ever needs to be
 * serious, swap it for a k-anonymity lookup against Have I Been Pwned rather
 * than growing this array.
 */
export const COMMON_PASSWORDS: readonly string[] = [
  "password", "password1", "password123", "passw0rd",
  "12345678", "123456789", "1234567890", "11111111", "00000000",
  "qwerty123", "qwertyui", "abc12345", "iloveyou", "letmein1",
  "admin123", "adminadmin", "welcome1", "sunshine", "football",
];
const BLOCKLIST = new Set(COMMON_PASSWORDS);

/**
 * A password being SET (registration, staff creation, a reset).
 *
 * Never trimmed: a leading or trailing space is part of the secret, and
 * trimming it here would silently store a different password than the one the
 * user typed — they would then fail to sign in from any client that doesn't
 * trim identically.
 */
export const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`)
  .refine((v) => v.trim().length > 0, "Password cannot be only spaces.")
  .refine((v) => !BLOCKLIST.has(v.toLowerCase()), "That password is too common — pick something less guessable.");

/**
 * A password being CHECKED (sign-in). Presence only.
 *
 * Applying the policy here would lock out every account created before the
 * policy existed, which is all of them. The rule belongs where a password is
 * chosen, never where one is verified.
 */
export const loginPasswordField = z.string().min(1, "Enter your password.");

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address."));

/**
 * Blank OR absent means "not supplied" rather than "invalid".
 *
 * Both cases matter and they are not the same: a form that renders the input
 * sends `""`, and a form that doesn't render it sends no key at all. An
 * optional field that only tolerates `""` fails the second case with
 * "expected string, received undefined".
 */
const blankOrAbsent = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

export const optionalEmailField = blankOrAbsent.pipe(emailField.optional());

const PHONE_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 15; // E.164 caps the whole number at 15 digits.

/**
 * Normalises to either `01001234567` or `+201001234567` and checks nothing
 * beyond plausibility.
 *
 * Deliberately not an Egyptian-mobile regex: registerTenant accepts country
 * `SA` as well as `EG`, so a `01[0125]\d{8}` rule would reject every Saudi
 * tenant's own number. This rejects "abc" and "123" — which is the actual
 * problem, since today the field accepts both.
 */
export const phoneField = z
  .string()
  .transform((raw) => {
    const trimmed = raw.trim();
    const international = trimmed.startsWith("+") || trimmed.startsWith("00");
    const digits = trimmed.replace(/\D/g, "").replace(/^00/, "");
    return international ? `+${digits}` : digits;
  })
  .refine((v) => {
    const digits = v.replace(/\D/g, "");
    return digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS;
  }, "Enter a valid phone number.");

export const optionalPhoneField = blankOrAbsent.pipe(phoneField.optional());

export const nameField = z
  .string()
  .trim()
  .min(1, "This field is required.")
  .max(NAME_MAX_LENGTH, `Must be at most ${NAME_MAX_LENGTH} characters.`);

/**
 * Mirrors SLUG_RE in src/server/onboarding/service.ts, which is the authority —
 * a slug becomes a subdomain, so anything this accepts and that rejects would
 * fail deep inside registerTenant with a raw Error instead of a field message.
 */
export const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Must be at least 2 characters.")
  .max(40, "Must be at most 40 characters.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens only.");

/**
 * http(s) only. The same rule sanitizeHttpUrl enforces at write time: a stored
 * `javascript:` URL that a merchant later clicks is stored XSS.
 */
export const httpUrlField = z
  .string()
  .trim()
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "Enter a valid http(s) URL.");

export const optionalHttpUrlField = blankOrAbsent.pipe(httpUrlField.optional());

/**
 * A trimmed, length-capped free-text field. The cap is the point: today
 * `notes` travels from the request body to the column with no bound at all.
 */
export const shortText = (max: number) =>
  z.string().trim().max(max, `Must be at most ${max} characters.`);
