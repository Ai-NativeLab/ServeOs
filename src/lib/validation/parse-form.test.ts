import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseForm } from "./parse-form";
import { emailField, nameField, optionalPhoneField, passwordField } from "./fields";

const schema = z.object({
  name: nameField,
  email: emailField,
  password: passwordField,
  phone: optionalPhoneField,
});

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("parseForm", () => {
  it("returns the parsed, normalised data on success", () => {
    const r = parseForm(schema, form({
      name: "  Roma Pizza ", email: " Owner@ROMA.com ", password: "goodpass1", phone: "0100 123 4567",
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toEqual({
      name: "Roma Pizza",
      email: "owner@roma.com",
      password: "goodpass1",
      phone: "01001234567",
    });
  });

  it("maps each failure onto its own field", () => {
    const r = parseForm(schema, form({ name: "", email: "nope", password: "short", phone: "abc" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(Object.keys(r.fieldErrors).sort()).toEqual(["email", "name", "password", "phone"]);
    expect(r.fieldErrors.password).toMatch(/at least 8/);
  });

  // ToastForm shows a single string, so there has to be one — and it must not
  // be just the first problem, or the user fixes one and discovers the next.
  it("joins the messages into one line for a toast", () => {
    const r = parseForm(schema, form({ name: "", email: "nope", password: "goodpass1" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("required");
    expect(r.error).toContain("valid email");
  });

  it("says a missing field is required rather than leaking the zod type error", () => {
    const r = parseForm(schema, form({ email: "a@b.com", password: "goodpass1" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.fieldErrors.name).toBe("This field is required.");
    expect(r.error).not.toMatch(/expected|undefined|invalid_type/i);
  });

  it("does not repeat an identical message twice", () => {
    const two = z.object({ a: nameField, b: nameField });
    const r = parseForm(two, form({ a: "", b: "" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("This field is required.");
  });

  // Next.js appends $ACTION_* entries to the FormData of a server action.
  it("ignores the framework's own form entries", () => {
    const fd = form({ name: "Roma", email: "a@b.com", password: "goodpass1" });
    fd.set("$ACTION_ID_abc", "whatever");
    const r = parseForm(schema, fd);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).not.toHaveProperty("$ACTION_ID_abc");
  });

  it("keeps an optional field absent rather than inventing a value", () => {
    const r = parseForm(schema, form({ name: "Roma", email: "a@b.com", password: "goodpass1", phone: "" }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.phone).toBeUndefined();
  });

  it("reports a file where a string was expected instead of throwing", () => {
    const fd = form({ email: "a@b.com", password: "goodpass1" });
    fd.set("name", new File(["x"], "x.txt"));
    const r = parseForm(schema, fd);
    expect(r.ok).toBe(false);
  });
});
