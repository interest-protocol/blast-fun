import { canonicalSuiAddress } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { z } from "zod";

import type {
  RecoveryWalletKind,
  CrewRestoreChallengeRequest,
  CrewRestoreVerifyRequest,
} from "@blast/core/modules/mission-control/crew-access/contracts.ts";
export type * from "@blast/core/modules/mission-control/crew-access/contracts.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const recoveryChallengeEnvelope = z.strictObject({ address: z.unknown().nonoptional(), recoveryId: z.unknown().nonoptional(), walletKind: z.unknown().nonoptional() });
const recoveryVerifyEnvelope = recoveryChallengeEnvelope.extend({ challengeId: z.unknown().nonoptional(), message: z.unknown().nonoptional(), signature: z.unknown().nonoptional() });
const recoveryIdSchema = z.string().regex(IDENTIFIER);
const walletKindSchema = z.enum(["embedded", "slush"]);

function walletKind(value: unknown): RecoveryWalletKind {
  const parsed = walletKindSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid recovery wallet kind.");
  return parsed.data;
}

function recoveryId(value: unknown): string {
  const parsed = recoveryIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid recovery identifier.");
  return parsed.data;
}

function bounded(value: unknown, maximum: number): string {
  const parsed = z.string().min(1).max(maximum).refine((text) => !text.includes("\0")).safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid recovery proof.");
  return parsed.data;
}

export function parseCrewRestoreChallengeRequest(
  value: unknown,
): CrewRestoreChallengeRequest {
  const parsed = recoveryChallengeEnvelope.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid recovery request.");
  const input = parsed.data;
  return {
    address: canonicalSuiAddress(input.address),
    recoveryId: recoveryId(input.recoveryId),
    walletKind: walletKind(input.walletKind),
  };
}

export function parseCrewRestoreVerifyRequest(
  value: unknown,
): CrewRestoreVerifyRequest {
  const parsed = recoveryVerifyEnvelope.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid recovery request.");
  const input = parsed.data;
  const challengeId = bounded(input.challengeId, 36);
  if (!z.string().regex(UUID).safeParse(challengeId).success) throw new TypeError("Invalid recovery challenge.");
  return {
    ...parseCrewRestoreChallengeRequest({
      address: input.address,
      recoveryId: input.recoveryId,
      walletKind: input.walletKind,
    }),
    challengeId: challengeId.toLowerCase(),
    message: bounded(input.message, 2_048),
    signature: bounded(input.signature, 8_192),
  };
}
