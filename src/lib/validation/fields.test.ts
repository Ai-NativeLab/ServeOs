import { describe, it, expect } from "vitest";
import {
  COMMON_PASSWORDS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  emailField,
  httpUrlField,
  loginPasswordField,
  nameField,
  optionalPhoneField,
  passwordField,
  phoneField,
  shortText,
  slugField,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
} from "./fields";

/** Terse helpers: these schemas are checked by the dozen below. */
const ok = <T,>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, input: unknown) => {
  const r = schema.safeParse(input);
  expect(r.success, `expected ${JSON.stringify(input)} to be accepted`).toBe(true);
  return r.data as T;
};
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) => {
  expect(schema.safeParse(input).success, `expected ${JSON.stringify(input)} to be rejected`).toBe(false);
};

describe("passwordField", () => {
  it("requires at least PASSWORD_MIN_LENGTH characters", () => {
    bad(passwordField, "short12");
    expect(ok(passwordField, "goodpass1")).toBe("goodpass1");
  });

  it("caps length, because scrypt cost grows with the input", () => {
    bad(passwordField, "a".repeat(PASSWORD_MAX_LENGTH + 1));
    ok(passwordField, "a".repeat(PASSWORD_MAX_LENGTH));
  });

  it("rejects the obvious passwords regardless of length", () => {
    for (const common of COMMON_PASSWORDS) bad(passwordField, common);
  });

  it("is case-insensitive about the blocklist", () => {
    bad(passwordField, "PASSWORD");
    bad(passwordField, "Password1");
  });

  it("never trims — a leading or trailing space is part of the secret", () => {
    expect(ok(passwordField, " spaced pass ")).toBe(" spaced pass ");
  });

  it("rejects whitespace-only", () => {
    bad(passwordField, "          ");
  });
});

describe("loginPasswordField", () => {
  // Applying the policy at sign-in would lock out every account created
  // before the policy existed — including the seeded demo owners.
  it("accepts any non-empty string, however weak", () => {
    expect(ok(loginPasswordField, "x")).toBe("x");
    expect(ok(loginPasswordField, "password")).toBe("password");
  });

  it("still rejects an empty submission", () => {
    bad(loginPasswordField, "");
  });
});

describe("emailField", () => {
  it("trims and lowercases, so the stored form is canonical", () => {
    expect(ok(emailField, "  Owner@Roma.COM  ")).toBe("owner@roma.com");
  });

  it("rejects what is not an address", () => {
    bad(emailField, "");
    bad(emailField, "nope");
    bad(emailField, "no@domain");
    bad(emailField, "a b@example.com");
  });
});

describe("phoneField", () => {
  it("keeps only the digits, so spacing and punctuation do not matter", () => {
    expect(ok(phoneField, "0100 123 4567")).toBe("01001234567");
    expect(ok(phoneField, "(010) 012-34567")).toBe("01001234567");
  });

  it("normalises an international prefix to a single leading +", () => {
    expect(ok(phoneField, "+20 100 123 4567")).toBe("+201001234567");
    expect(ok(phoneField, "00201001234567")).toBe("+201001234567");
  });

  // Deliberately not EG-only: registerTenant accepts country SA, and a Saudi
  // tenant's 05xxxxxxxx must survive the same field.
  it("accepts a Saudi mobile too", () => {
    expect(ok(phoneField, "0512345678")).toBe("0512345678");
    expect(ok(phoneField, "+966512345678")).toBe("+966512345678");
  });

  it("rejects things that cannot be a number", () => {
    bad(phoneField, "");
    bad(phoneField, "abc");
    bad(phoneField, "12345");
    bad(phoneField, "1".repeat(16));
  });
});

describe("optionalPhoneField", () => {
  it("treats blank as absent rather than invalid", () => {
    expect(ok(optionalPhoneField, "")).toBeUndefined();
    expect(ok(optionalPhoneField, "   ")).toBeUndefined();
  });

  // A rendered-but-empty input sends "", a field the form never rendered sends
  // no key at all. Both are "not supplied" and only the first is obvious.
  it("treats a missing key as absent too", () => {
    expect(ok(optionalPhoneField, undefined)).toBeUndefined();
  });

  it("still validates a value that was supplied", () => {
    bad(optionalPhoneField, "abc");
    expect(ok(optionalPhoneField, "0100 123 4567")).toBe("01001234567");
  });
});

describe("nameField", () => {
  it("trims", () => {
    expect(ok(nameField, "  Roma Pizza  ")).toBe("Roma Pizza");
  });

  it("rejects blank and over-long", () => {
    bad(nameField, "");
    bad(nameField, "   ");
    bad(nameField, "n".repeat(121));
  });
});

describe("slugField", () => {
  it("lowercases and trims", () => {
    expect(ok(slugField, "  Roma  ")).toBe("roma");
  });

  it("accepts only lowercase letters, digits and hyphens", () => {
    ok(slugField, "roma-pizza-2");
    bad(slugField, "roma pizza");
    bad(slugField, "roma_pizza");
    bad(slugField, "-roma");
    bad(slugField, "roma-");
    bad(slugField, "roma--pizza");
  });

  it("enforces the subdomain length bounds", () => {
    bad(slugField, "ro");
    ok(slugField, "rom");
    ok(slugField, "r".repeat(SLUG_MAX_LENGTH));
    bad(slugField, "r".repeat(SLUG_MAX_LENGTH + 1));
  });

  // registerTenant re-checks the slug and throws a raw Error if it disagrees,
  // which the UI shows as a crash rather than as a field message. The two must
  // not be able to drift, so the service imports these very constants.
  it("agrees with the rule registerTenant enforces", () => {
    for (const candidate of ["rom", "roma-pizza-2", "ro", "roma--pizza", "-roma", "roma-", "Roma", "r".repeat(33)]) {
      const acceptedHere = slugField.safeParse(candidate).success;
      const normalised = candidate.trim().toLowerCase();
      const acceptedThere =
        normalised.length >= SLUG_MIN_LENGTH &&
        normalised.length <= SLUG_MAX_LENGTH &&
        SLUG_PATTERN.test(normalised);
      expect(acceptedHere, `disagreement on ${JSON.stringify(candidate)}`).toBe(acceptedThere);
    }
  });
});

describe("httpUrlField", () => {
  it("accepts http and https", () => {
    expect(ok(httpUrlField, " https://example.com/a.png ")).toBe("https://example.com/a.png");
    ok(httpUrlField, "http://example.com");
  });

  // The same rule sanitizeHttpUrl already enforces at write time: anything
  // rendered as an href must not be able to carry script.
  it("rejects any other scheme", () => {
    bad(httpUrlField, "javascript:alert(1)");
    bad(httpUrlField, "data:text/html,<script>");
    bad(httpUrlField, "not a url");
  });
});

describe("shortText", () => {
  it("trims and enforces the cap it was given", () => {
    const s = shortText(10);
    expect(ok(s, "  hello  ")).toBe("hello");
    bad(s, "x".repeat(11));
  });

  it("allows blank, since a short text field is usually optional", () => {
    expect(ok(shortText(10), "")).toBe("");
  });
});

describe("the policy constants", () => {
  it("keeps the 8-character minimum the app already advertises", () => {
    // src/app/account/AccountForms.tsx says "Password (8+ characters)" and
    // two forms carry minLength={8}. The server must not be laxer than the
    // label, or the label is a lie.
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });

  it("blocklists nothing that a seeded demo account uses", () => {
    // scripts/seed.ts signs the demo owners in with these; blocklisting one
    // would break every e2e login rather than any real user's password.
    for (const seeded of ["owner1234", "manager1234", "staff1234"]) {
      expect(COMMON_PASSWORDS).not.toContain(seeded);
    }
  });
});
