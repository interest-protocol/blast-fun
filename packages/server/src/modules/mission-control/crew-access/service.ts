import type { Pool } from "pg";

import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import {
  MemberSessionError,
  type MemberSessionService,
  type SessionCookieSink,
} from "@blast/server/modules/mission-control/member-sessions/index.ts";
import type { WalletControlProof } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { CrewAccessError } from "./errors.ts";
import { CrewAccessRepository } from "./repository.ts";

export type AuthorizedCrewAccess = Readonly<{
  profileId: string;
}>;

export class CrewAccessService {
  readonly #pool: Pool;
  readonly #repository: CrewAccessRepository;
  readonly #sessions: MemberSessionService;

  constructor(input: {
    pool: Pool;
    repository?: CrewAccessRepository;
    sessions: MemberSessionService;
  }) {
    this.#pool = input.pool;
    this.#repository = input.repository ?? new CrewAccessRepository();
    this.#sessions = input.sessions;
  }

  async resume(request: Request): Promise<AuthorizedCrewAccess> {
    const authorization = await this.#sessions.authorize(request);
    return { profileId: authorization.profileId };
  }

  async restore(input: {
    expectedOrigin: string;
    privyDid: string | null;
    proof: WalletControlProof;
    request: Request;
    setCookie: SessionCookieSink;
  }): Promise<AuthorizedCrewAccess> {
    if (
      input.proof.action !== "restore_crew_access" ||
      input.proof.context.kind !== "recovery" ||
      input.proof.origin !== input.expectedOrigin
    ) {
      throw new CrewAccessError("CREW_ACCESS_DENIED");
    }
    let profileId: string | null;
    try {
      profileId = await withTransaction(this.#pool, (transaction) =>
        this.#repository.findCompletedProfileByWallet(transaction, {
          address: input.proof.address,
          privyDid: input.privyDid,
        }),
      );
    } catch {
      throw new CrewAccessError("CREW_ACCESS_UNAVAILABLE");
    }
    if (!profileId) throw new CrewAccessError("CREW_ACCESS_DENIED");

    try {
      await this.#sessions.issue(
        input.request,
        input.expectedOrigin,
        { profileId },
        input.setCookie,
      );
    } catch (error) {
      if (error instanceof MemberSessionError) {
        throw new CrewAccessError("CREW_ACCESS_UNAVAILABLE");
      }
      if (error instanceof CrewAccessError) throw error;
      throw new CrewAccessError("CREW_ACCESS_UNAVAILABLE");
    }
    return { profileId };
  }
}
