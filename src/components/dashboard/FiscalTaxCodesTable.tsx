import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProductTaxCodeView, UnclassifiedProductView } from "@/server/fiscal/config-service";

/**
 * Which products ETA can represent, and which cannot be sold compliantly yet.
 *
 * The UNCLASSIFIED list leads deliberately. A product with no
 * `product_tax_codes` row fails its receipt permanently
 * (`MissingTaxCodeError`) the moment it is sold — the sale still completes, but
 * the document never does — so the useful thing to show an owner first is the
 * work outstanding, not the work done.
 *
 * Props-driven; the `import type` is erased at compile time and pulls no server
 * module into the component tree.
 */
export function FiscalTaxCodesTable({
  classified,
  unclassified,
}: {
  classified: ProductTaxCodeView[];
  unclassified: UnclassifiedProductView[];
}) {
  return (
    <>
      {unclassified.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400 mb-4">
          <p className="font-medium">
            {unclassified.length} product{unclassified.length === 1 ? "" : "s"} not classified for ETA.
          </p>
          <p className="mt-1 text-xs">
            Selling one of these completes the sale but its fiscal document fails permanently — ETA needs an item
            code, tax type and unit type per line, and none of them can be guessed.
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {unclassified.map((p) => (
              <li key={p.productId} className="font-medium">
                {p.productName}
                {p.productSku && <span className="font-normal"> · {p.productSku}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {classified.length === 0 ? (
        <EmptyState
          title="No products classified"
          description="Classify each product you sell with its ETA item, tax and unit codes before going live."
        />
      ) : (
        <Card className="p-0 overflow-x-auto mb-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Code source</TableHead>
                <TableHead>Item code</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>EGS approval</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {classified.map((c) => (
                <TableRow key={c.productId}>
                  <TableCell className="font-medium">
                    {c.productName}
                    {c.productSku && (
                      <span className="block text-xs text-muted-foreground font-normal">{c.productSku}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs uppercase">{c.codeSource}</TableCell>
                  <TableCell className="font-mono text-xs">{c.itemCode}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {c.taxType}
                    {c.taxSubType && <span className="text-muted-foreground"> / {c.taxSubType}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{c.unitType}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {/* Only meaningful for EGS codes — a GS1 code is usable the
                        moment it is entered, so a blank here is not a gap. */}
                    {c.codeSource === "egs" ? c.egsApprovalStatus ?? "not recorded" : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
