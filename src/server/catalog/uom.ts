import { pgEnum } from "drizzle-orm/pg-core";
import { UNIT_OF_MEASURE_VALUES } from "./uom-values";

/**
 * ONE unit-of-measure enum for the whole platform (decision T1). Spec 8
 * (Inventory Core, #51 — not yet built) also needs a UoM concept for
 * ingredients; rather than two enums claiming the same idea, this superset
 * covers both domains. Spec 8 imports THIS enum when it lands — a build-order
 * accident (P4 shipped first), not P4 owning inventory. Spec 8 still owns the
 * ledger, lots and base/purchase/recipe conversion-factor machinery.
 *
 * Schema-only (drizzle) — client code imports ./uom-values instead.
 */
export const unitOfMeasureEnum = pgEnum("unit_of_measure", UNIT_OF_MEASURE_VALUES);

export * from "./uom-values";
