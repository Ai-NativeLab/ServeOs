import type { AuditFingerprint } from "./service";

/** The build version surfaced to the audit trail; unset in dev is fine (null). */
const WEB_APP_VERSION = process.env.SERVEOS_APP_VERSION ?? null;

export function emptyFingerprint(): AuditFingerprint {
  return { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null };
}

/** First hop of X-Forwarded-For, else X-Real-IP. */
function clientIp(h: Headers): string | null {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() || null;
}

export function headersFingerprint(h: Headers): AuditFingerprint {
  return {
    deviceId: null,
    deviceTokenHash: null,
    appVersion: WEB_APP_VERSION,
    ip: clientIp(h),
    userAgent: h.get("user-agent"),
  };
}

export function webFingerprint(req: Request): AuditFingerprint {
  return headersFingerprint(req.headers);
}
