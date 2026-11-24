import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type AuthConfig = Readonly<{
  origin: string;
  key: Buffer;
  secure: boolean;
}>;
type Session = { subject: string; expires: number };

export function authConfig(
  env: Readonly<Record<string, string | undefined>>,
): AuthConfig {
  let origin: URL;
  try {
    origin = new URL(env.ANALYTICS_DASHBOARD_ORIGIN ?? "");
  } catch {
    throw new Error("Invalid dashboard origin");
  }
  const secure = origin.protocol === "https:";
  const local =
    env.NODE_ENV === "development" &&
    origin.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(origin.hostname);
  if (
    (!secure && !local) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    ![origin.origin, `${origin.origin}/`].includes(
      env.ANALYTICS_DASHBOARD_ORIGIN ?? "",
    )
  )
    throw new Error("Invalid dashboard origin");
  const key = Buffer.from(env.ANALYTICS_SESSION_KEY ?? "", "base64url");
  if (
    key.length !== 32 ||
    key.toString("base64url") !== env.ANALYTICS_SESSION_KEY
  )
    throw new Error("Private authentication is not configured");
  return { origin: origin.origin, key, secure };
}
export function seal(config: AuthConfig, value: Session): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.key, iv);
  cipher.setAAD(Buffer.from(`${config.origin}:session`));
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
}
export function cookieName(config: AuthConfig): string {
  return `${config.secure ? "__Host-" : ""}blast_analytics_session`;
}
export function cookie(config: AuthConfig, value: string, age: number): string {
  return `${cookieName(config)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secure ? "; Secure" : ""}`;
}
export function readCookie(
  header: string | undefined,
  name: string,
): string | null {
  const values = (header ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${name}=`));
  const parts = (header ?? "").split(";").map((part) => part.trim());
  if (
    (header?.length ?? 0) > 4096 ||
    (header &&
      parts.some(
        (part) =>
          !/^[!#$%&'*+.^_`|~A-Za-z0-9-]+=[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(
            part,
          ),
      ))
  )
    return null;
  if (new Set(parts.map((part) => part.split("=")[0])).size !== parts.length)
    return null;
  return values.length === 1 ? values[0]!.slice(name.length + 1) : null;
}
export function session(
  config: AuthConfig,
  header: string | undefined,
): Session | null {
  try {
    const value = readCookie(header, cookieName(config));
    if (!value || value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value))
      return null;
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length < 29 || bytes.toString("base64url") !== value) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      config.key,
      bytes.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(`${config.origin}:session`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const data = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString(),
    ) as Session;
    const now = Date.now();
    return data !== null &&
      typeof data === "object" &&
      Object.keys(data).length === 2 &&
      typeof data.subject === "string" &&
      /^code:[a-f0-9]{64}$/.test(data.subject) &&
      Number.isSafeInteger(data.expires) &&
      data.expires > now &&
      data.expires <= now + 4 * 3_600_000
      ? data
      : null;
  } catch {
    return null;
  }
}
