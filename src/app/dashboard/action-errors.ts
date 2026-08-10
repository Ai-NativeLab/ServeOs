import { DomainError } from "@/shared/errors";

/**
 * Converts a caught DomainError into a value a server action can return.
 *
 * Thrown errors do not cross the RSC boundary intact — the class identity is
 * lost and production strips the message down to a digest — so ToastForm can
 * only show the domain's localized message if the action returns it as data.
 * Anything that is not a DomainError rethrows to the error boundary: those are
 * bugs, not operator feedback.
 */
export function domainErrorValue(e: unknown): { error: string } {
  if (e instanceof DomainError) return { error: e.messageFor("en") };
  throw e;
}
