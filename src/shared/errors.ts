export type Locale = "en" | "ar";

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract messageFor(locale: Locale): string;
}
