import { formatDayTime } from "@/lib/datetime";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DeviceCredentialView } from "@/server/fiscal/config-service";

/**
 * The ETA credential each till holds, MASKED.
 *
 * The "Secrets" column is the only report there can be on what is stored: the
 * `*_ref` columns are write-only through the config service, so this renders
 * the `has…` booleans it is given and never a reference. Nothing here can leak
 * one because nothing here is ever handed one.
 *
 * Props-driven; the `import type` is erased at compile time and pulls no server
 * module into the component tree.
 */
export function FiscalCredentialsTable({
  credentials,
  timezone,
}: {
  credentials: DeviceCredentialView[];
  timezone: string;
}) {
  if (credentials.length === 0) return null;

  return (
    <Card className="p-0 overflow-x-auto mb-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Till</TableHead>
            <TableHead>ETA serial</TableHead>
            <TableHead>Client id</TableHead>
            <TableHead>Secrets</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Activated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {credentials.map((c) => (
            <TableRow key={c.deviceId}>
              <TableCell className="font-medium">{c.deviceLabel ?? c.deviceId.slice(0, 8)}</TableCell>
              <TableCell className="font-mono text-xs">{c.etaSerial}</TableCell>
              <TableCell className="font-mono text-xs">{c.clientId}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {[c.hasSecret1 && "secret 1", c.hasSecret2 && "secret 2", c.hasPresharedKey && "pre-shared key"]
                  .filter(Boolean)
                  .join(" · ") || "none"}
              </TableCell>
              <TableCell className="text-xs">{c.status}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {c.activatedAt ? formatDayTime(c.activatedAt, timezone) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
