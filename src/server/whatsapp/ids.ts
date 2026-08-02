/**
 * Interactive ids are `<action>:<stateVersion>:<payload>`.
 *
 * The version is what makes a tap on a superseded message rejectable: that tap
 * arrives as a brand-new wamid, so providerMessageId dedup cannot catch it.
 *
 * Lives in its own module so reducer.ts and render.ts can both use it without
 * importing each other.
 */
export function actionId(action: string, version: number, payload: string): string {
  return `${action}:${version}:${payload}`;
}

export function parseActionId(id: string): { action: string; version: number; payload: string } | null {
  const parts = id.split(":");
  if (parts.length < 3) return null;
  const version = Number(parts[1]);
  if (!Number.isInteger(version)) return null;
  return { action: parts[0], version, payload: parts.slice(2).join(":") };
}
