import { DomainError, type Locale } from "@/shared/errors";

export class BranchNotFoundError extends DomainError {
  readonly code = "branch_not_found";
  constructor() {
    super("Branch not found");
    this.name = "BranchNotFoundError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "الفرع غير موجود" : "Branch not found";
  }
}
