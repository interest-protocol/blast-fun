import { z } from "zod";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  assertTrustedMutationRequest,
  opaqueSessionCookie,
} from "@blast/core/lib/web-security/mutation-guard.ts";
import { withTransaction, type ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import {
  DEFAULT_MEMBER_SESSION_POLICY,
  MEMBER_SESSION_REFRESH_INTERVAL_MS,
  MEMBER_SESSION_SCOPE,
  memberSessionPolicySchema,
  type IssueMemberSessionInput,
  type MemberAuthorization,
  type MemberSessionPolicy,
  type SessionCookieSink,
} from "@blast/core/modules/mission-control/member-sessions/contracts.ts";
import { readMemberSessionToken } from "@blast/server/modules/mission-control/member-sessions/cookies.ts";
import { MemberSessionError } from "@blast/server/modules/mission-control/member-sessions/errors.ts";
import { MemberSessionRepository } from "@blast/server/modules/mission-control/member-sessions/repository.ts";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validatePolicy(policy: MemberSessionPolicy): MemberSessionPolicy {
  const parsed = memberSessionPolicySchema.safeParse(policy);
  if (!parsed.success) throw new MemberSessionError("SESSION_CONFIGURATION_INVALID");
  return Object.freeze({ ...policy });
}

export class MemberSessionService {
  readonly #clock: () => Date;
  readonly #policy: MemberSessionPolicy;
  readonly #pool: Pool;
  readonly #repository: MemberSessionRepository;
  readonly #tokenFactory: () => string;

  constructor(input: {
    pool: Pool;
    clock?: () => Date;
    policy?: MemberSessionPolicy;
    repository?: MemberSessionRepository;
    tokenFactory?: () => string;
  }) {
    this.#pool = input.pool;
    this.#clock = input.clock ?? (() => new Date());
    this.#policy = validatePolicy(
      input.policy ?? DEFAULT_MEMBER_SESSION_POLICY,
    );
    this.#repository = input.repository ?? new MemberSessionRepository();
    this.#tokenFactory =
      input.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  async issue(
    request: Request,
    expectedOrigin: string,
    input: IssueMemberSessionInput,
    setCookie: SessionCookieSink,
  ): Promise<MemberAuthorization> {
    assertTrustedMutationRequest(request, expectedOrigin);
    const token = this.#tokenFactory();
    if (!z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(token).success || !input.profileId) {
      throw new MemberSessionError("SESSION_CONFIGURATION_INVALID");
    }
    const now = this.#now();
    const idleExpiresAt = new Date(
      now.getTime() + this.#policy.idleTtlMs,
    );
    const absoluteExpiresAt = new Date(
      now.getTime() + this.#policy.absoluteTtlMs,
    );
    const scope = input.scope ?? MEMBER_SESSION_SCOPE;

    try {
      await this.#run((database) =>
        this.#repository.create(database, {
          absoluteExpiresAt: absoluteExpiresAt.toISOString(),
          createdAt: now.toISOString(),
          idleExpiresAt: idleExpiresAt.toISOString(),
          profileId: input.profileId,
          scope,
          sessionId: randomUUID(),
          tokenHash: tokenHash(token),
        }),
      );
    } catch {
      throw new MemberSessionError("SESSION_UNAVAILABLE");
    }

    setCookie(
      opaqueSessionCookie(
        token,
        Math.ceil(this.#policy.absoluteTtlMs / 1_000),
      ),
    );
    return { profileId: input.profileId, scope };
  }

  async authorize(request: Request): Promise<MemberAuthorization> {
    const token = readMemberSessionToken(request);
    if (!token) throw new MemberSessionError("SESSION_INVALID");
    const now = this.#now();
    const idleExpiresAt = new Date(
      now.getTime() + this.#policy.idleTtlMs,
    );
    const refreshDueBefore = new Date(
      now.getTime() -
        Math.min(
          MEMBER_SESSION_REFRESH_INTERVAL_MS,
          Math.floor(this.#policy.idleTtlMs / 2),
        ),
    );
    let authorization: MemberAuthorization | null;
    try {
      authorization = await this.#repository.authorizeAndRefresh(this.#pool, {
        idleExpiresAt: idleExpiresAt.toISOString(),
        now: now.toISOString(),
        refreshDueBefore: refreshDueBefore.toISOString(),
        tokenHash: tokenHash(token),
      });
    } catch {
      throw new MemberSessionError("SESSION_UNAVAILABLE");
    }
    if (!authorization) throw new MemberSessionError("SESSION_INVALID");
    return authorization;
  }

  async revoke(request: Request): Promise<boolean> {
    const token = readMemberSessionToken(request);
    if (!token) return false;
    const now = this.#now().toISOString();
    try {
      return await this.#run((database) =>
        this.#repository.revoke(database, {
          now,
          tokenHash: tokenHash(token),
        }),
      );
    } catch {
      throw new MemberSessionError("SESSION_UNAVAILABLE");
    }
  }

  #run<Result>(
    operation: (database: ModuleTransaction<"session">) => Promise<Result>,
  ): Promise<Result> {
    return withTransaction(this.#pool, (transaction) =>
      operation(transaction.forModule("session")),
    );
  }

  #now(): Date {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) {
      throw new MemberSessionError("SESSION_CONFIGURATION_INVALID");
    }
    return now;
  }
}

export async function issueMemberSession(
  request: Request,
  expectedOrigin: string,
  service: MemberSessionService,
  input: IssueMemberSessionInput,
  setCookie: SessionCookieSink,
): Promise<MemberAuthorization> {
  return service.issue(request, expectedOrigin, input, setCookie);
}

export function getMemberSession(
  request: Request,
  service: MemberSessionService,
): Promise<MemberAuthorization> {
  return service.authorize(request);
}

export function revokeMemberSession(
  request: Request,
  expectedOrigin: string,
  service: Pick<MemberSessionService, "revoke">,
): Promise<boolean> {
  assertTrustedMutationRequest(request, expectedOrigin);
  return service.revoke(request);
}
