import { DomainError, type Locale } from "@/shared/errors";

export class CategoryNotEmptyError extends DomainError {
  readonly code = "category_not_empty";
  constructor() {
    super("Category still has products");
    this.name = "CategoryNotEmptyError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "أزل جميع المنتجات أولاً" : "Remove all products first";
  }
}

export class ProductNotFoundError extends DomainError {
  readonly code = "product_not_found";
  constructor() {
    super("Product not found");
    this.name = "ProductNotFoundError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "المنتج غير موجود" : "Product not found";
  }
}

export class InvalidModifierRulesError extends DomainError {
  readonly code = "invalid_modifier_rules";
  constructor() {
    super("Invalid modifier selection rules");
    this.name = "InvalidModifierRulesError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "قواعد الاختيار غير صالحة" : "Invalid selection rules";
  }
}

export class InvalidVariantError extends DomainError {
  readonly code = "invalid_variant";
  constructor() {
    super("Invalid product variant");
    this.name = "InvalidVariantError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "خيار المنتج غير متاح" : "That product option is unavailable";
  }
}
