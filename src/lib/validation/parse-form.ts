import { z } from "zod";

export type ParseFormResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors: Record<string, string> };

/**
 * Next appends its own bookkeeping entries to a server action's FormData
 * (see the Forms guide in node_modules/next/dist/docs). A zod object strips
 * unknown keys by default, so they never reach the parsed data — but skipping
 * them here keeps the object we hand to safeParse honest.
 */
const isFrameworkKey = (key: string) => key.startsWith("$ACTION");

/**
 * zod's default message for an absent key is "Invalid input: expected string,
 * received undefined" — accurate, and useless to the person filling the form.
 */
const FIELD_REQUIRED = "This field is required.";

function messageFor(issue: z.core.$ZodIssue): string {
  const missing = issue.code === "invalid_type" && issue.input === undefined;
  return missing ? FIELD_REQUIRED : issue.message;
}

/**
 * Parses a server action's FormData through a zod object schema.
 *
 * Returns rather than throws, because a thrown error does not survive the RSC
 * boundary intact — the class is lost and production redacts the message. The
 * `{ error }` shape is what ToastForm and the useActionState forms already
 * consume, so an action adopting this needs no UI change to start reporting
 * real messages; `fieldErrors` is there for forms that later want them inline.
 */
export function parseForm<S extends z.ZodType>(schema: S, formData: FormData): ParseFormResult<z.infer<S>> {
  const raw: Record<string, FormDataEntryValue> = {};
  for (const [key, value] of formData.entries()) {
    if (!isFrameworkKey(key)) raw[key] = value;
  }

  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };

  const fieldErrors: Record<string, string> = {};
  const messages: string[] = [];
  for (const issue of result.error.issues) {
    const message = messageFor(issue);
    // First issue per field wins: later ones are usually downstream of it
    // (a blank string fails "required" and "too short" together).
    const field = issue.path.map(String).join(".");
    if (field && !(field in fieldErrors)) fieldErrors[field] = message;
    if (!messages.includes(message)) messages.push(message);
  }

  return { ok: false, error: messages.join(" "), fieldErrors };
}
