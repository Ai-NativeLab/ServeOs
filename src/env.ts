export type Env = {
  DATABASE_URL: string;
  ROOT_DOMAIN: string;
};

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const DATABASE_URL = source.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("Missing required env: DATABASE_URL");
  return {
    DATABASE_URL,
    ROOT_DOMAIN: source.ROOT_DOMAIN ?? "serveos.localhost",
  };
}

export const getEnv = (): Env => loadEnv();
