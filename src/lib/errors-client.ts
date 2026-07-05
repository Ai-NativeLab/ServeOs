import { DomainError } from "@/shared/errors";

export function toastMessageFor(err: unknown): string {
  if (err instanceof DomainError) return err.messageFor("en");
  return "Something went wrong. Please try again.";
}
