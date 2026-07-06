import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { branches } from "@/server/branches/schema";
import { posDevices, posPairingCodes, type PosDevice } from "./schema";
import { PosPairingError } from "./errors";

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** 8 uppercase alphanumeric characters, e.g. "A7K2P9QM". */
function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

/** 64 hex chars — the opaque device bearer token. */
function generateDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

export async function createPairingCode(
  tenantId: string,
  branchId: string,
  label: string,
  userId: string,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  await db.insert(posPairingCodes).values({
    tenantId, branchId, code, label, createdByUserId: userId, expiresAt,
  });
  return { code, expiresAt };
}

export async function redeemPairingCode(
  code: string,
): Promise<{ deviceToken: string; tenantId: string; branchId: string; branchName: string }> {
  const [pairing] = await db
    .select()
    .from(posPairingCodes)
    .where(and(
      eq(posPairingCodes.code, code),
      isNull(posPairingCodes.usedAt),
      gt(posPairingCodes.expiresAt, new Date()),
    ))
    .limit(1);

  if (!pairing) throw new PosPairingError();

  // branches enforces RLS, so the lookup must run inside the tenant's context.
  const [branch] = await withTenant(pairing.tenantId, (tx) =>
    tx.select({ name: branches.name })
      .from(branches)
      .where(eq(branches.id, pairing.branchId))
      .limit(1),
  );
  if (!branch) throw new PosPairingError("Pairing code references a missing branch");

  const deviceToken = generateDeviceToken();
  await db.insert(posDevices).values({
    tenantId: pairing.tenantId,
    branchId: pairing.branchId,
    token: deviceToken,
    label: pairing.label,
    createdByUserId: pairing.createdByUserId,
  });
  await db.update(posPairingCodes).set({ usedAt: new Date() }).where(eq(posPairingCodes.id, pairing.id));

  return { deviceToken, tenantId: pairing.tenantId, branchId: pairing.branchId, branchName: branch.name };
}

export async function resolveDevice(
  token: string,
): Promise<{ deviceId: string; tenantId: string; branchId: string } | null> {
  const [device] = await db
    .select({ id: posDevices.id, tenantId: posDevices.tenantId, branchId: posDevices.branchId })
    .from(posDevices)
    .where(and(eq(posDevices.token, token), isNull(posDevices.revokedAt)))
    .limit(1);
  return device ? { deviceId: device.id, tenantId: device.tenantId, branchId: device.branchId } : null;
}

export async function listDevices(tenantId: string): Promise<PosDevice[]> {
  return db
    .select()
    .from(posDevices)
    .where(eq(posDevices.tenantId, tenantId))
    .orderBy(desc(posDevices.createdAt));
}

export async function revokeDevice(tenantId: string, deviceId: string): Promise<void> {
  await db
    .update(posDevices)
    .set({ revokedAt: new Date() })
    .where(and(eq(posDevices.id, deviceId), eq(posDevices.tenantId, tenantId)));
}
