import { describe, it, expect } from "vitest";
import { DomainError, NonFiniteAmountError, type Locale } from "@/shared/errors";
import { domainErrorValue } from "./action-errors";

class SampleDomainError extends DomainError {
  readonly code = "sample";
  messageFor(_locale: Locale): string { return "operator feedback"; }
}

describe("domainErrorValue", () => {
  it("turns a DomainError into operator feedback", () => {
    expect(domainErrorValue(new SampleDomainError())).toEqual({ error: "operator feedback" });
  });

  it("rethrows a NonFiniteAmountError to the error boundary instead of toasting it", () => {
    // An invariant violation is a bug, not something the operator can fix by
    // trying again — it must reach logging and the error boundary, not be
    // swallowed into a toast.
    const bug = new NonFiniteAmountError("money", Number.NaN);
    expect(() => domainErrorValue(bug)).toThrow(bug);
  });
});

describe("NonFiniteAmountError", () => {
  it("is not a DomainError, so no route maps it to a 4xx", () => {
    // `api/orders` (and the cancel route) answer 422 for any DomainError and
    // skip their console.error; keeping this out of the hierarchy is what
    // sends it down the logged 500 path instead.
    expect(new NonFiniteAmountError("money", Number.POSITIVE_INFINITY)).not.toBeInstanceOf(DomainError);
  });
});
