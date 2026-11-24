import { z } from "zod";
import { createPublicKey, type KeyObject } from "node:crypto";
import { decodeJwt, errors, jwtVerify } from "jose";
import { PrivyAdapterError } from "./errors.ts";
import { PRIVY_TOKEN_ISSUER, type PrivyAccessClaims } from "./types.ts";

export type PrivyTokenVerifierOptions = Readonly<{
  appId: string;
  clockSkewSeconds?: number;
  now?: () => number;
  verificationKey: string;
}>;

function loadP256Key(value: string): KeyObject {
  try {
    const key = createPublicKey(value.replaceAll("\\n", "\n"));
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      throw new Error("not a P-256 key");
    }
    return key;
  } catch {
    throw new PrivyAdapterError("INVALID_CONFIGURATION");
  }
}

const requiredStringSchema = z.string().min(1);
const timestampSchema = z.number().int().nonnegative();
const accessTokenSchema = z.string().max(16_384);

function requiredString(value: unknown): string | null {
  const parsed = requiredStringSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function requiredTimestamp(value: unknown): number | null {
  const parsed = timestampSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createPrivyTokenVerifier(
  options: PrivyTokenVerifierOptions,
): (accessToken: string) => Promise<PrivyAccessClaims> {
  const appId = requiredString(options.appId);
  const issuer = PRIVY_TOKEN_ISSUER;
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const clockSkewSeconds = options.clockSkewSeconds ?? 0;

  if (
    !appId ||
    !timestampSchema.safeParse(clockSkewSeconds).success
  ) {
    throw new PrivyAdapterError("INVALID_CONFIGURATION");
  }

  const verificationKey = loadP256Key(options.verificationKey);

  return async (accessToken) => {
    if (!accessTokenSchema.safeParse(accessToken).success) {
      throw new PrivyAdapterError("INVALID_ACCESS_TOKEN");
    }

    let payload;
    try {
      payload = decodeJwt(accessToken);
    } catch {
      throw new PrivyAdapterError("INVALID_ACCESS_TOKEN");
    }
    const currentTime = now();
    const expiration = requiredTimestamp(payload.exp);
    const issuedAt = requiredTimestamp(payload.iat);
    const sessionId = requiredString(payload.sid);
    const userId = requiredString(payload.sub);

    if (
      payload.iss !== issuer ||
      payload.aud !== appId ||
      expiration === null ||
      issuedAt === null ||
      !sessionId ||
      !userId?.startsWith("did:privy:") ||
      issuedAt > currentTime + clockSkewSeconds
    ) {
      throw new PrivyAdapterError("INVALID_ACCESS_TOKEN");
    }

    try {
      await jwtVerify(accessToken, verificationKey, {
        algorithms: ["ES256"],
        issuer,
        audience: appId,
        clockTolerance: clockSkewSeconds,
        currentDate: new Date(currentTime * 1_000),
      });
    } catch (error) {
      throw new PrivyAdapterError(error instanceof errors.JWTExpired ? "ACCESS_TOKEN_EXPIRED" : "INVALID_ACCESS_TOKEN");
    }

    return {
      appId,
      expiration,
      issuedAt,
      issuer,
      sessionId,
      userId,
    };
  };
}
