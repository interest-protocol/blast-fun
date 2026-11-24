import { randomUUID } from "node:crypto";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";

import type { LaunchpadActor } from "@blast/server/modules/launchpad-identity/contracts.ts";
import { LaunchpadMutationError } from "@blast/server/modules/launchpad-identity/errors.ts";
import {
  createLaunchpadMutationHandler,
  type LaunchpadMutationDefinition,
  type LaunchpadMutationDependencies,
} from "@blast/server/modules/launchpad-identity/mutation.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import {
  parsePostInput,
  type HolderProof,
} from "@blast/server/modules/launchpad-social/contracts.ts";
import {
  POST_FIELDS,
  type PostInput,
  type PostKind,
} from "@blast/core/modules/launchpad-social/post-contract.ts";
import type { HolderProofPort } from "@blast/server/modules/launchpad-social/holder-proof.ts";
import {
  SOCIAL_LIMITS,
  type SocialLimits,
} from "@blast/core/modules/launchpad-social/limits.ts";
import { publicPost } from "@blast/server/modules/launchpad-social/reads.ts";
import {
  authorIdentity,
  checkLaunch,
  insertPost,
  materializeSearchDocument,
  readRecord,
  removeSearchDocument,
  type AuthorIdentity,
  type PostRecord,
  type SocialTransaction,
} from "@blast/server/modules/launchpad-social/repository.ts";

/** A parsed post write and, after `prepare`, its holder proof. */
export type PreparedPost = PostInput &
  Readonly<{ holderProof: HolderProof | null }>;

export type PostMutationDependencies = Readonly<{
  /** The optional checkpointed holder proof; without one a disclosed wallet is `unavailable`. */
  holderProof?: HolderProofPort | null;
  /** The deployment this app serves; a database indexing another accepts no record. Null checks nothing. */
  expected: ExpectedDeployment | null;
  /** The provisional limits (default `SOCIAL_LIMITS`). */
  limits?: SocialLimits;
  createId?: () => string;
}>;

const REVISION_TAKEN = "mission_control_launchpad_theses_revision_of_key";

function identityOf(actor: LaunchpadActor): AuthorIdentity {
  return actor.method === "privy"
    ? { method: "privy", subjectKey: actor.subjectKey, walletAddress: null }
    : {
        method: "wallet_proof",
        subjectKey: null,
        walletAddress: actor.walletAddress,
      };
}

/** A disclosed wallet must be the writer's own: the proven wallet, or the Privy user's embedded wallet. */
function ownsDisclosedWallet(actor: LaunchpadActor, input: PostInput): boolean {
  return (
    input.disclosure.walletAddress === null ||
    input.disclosure.walletAddress === actor.walletAddress
  );
}

function isRevisionTaken(error: unknown): boolean {
  const pg = error as { code?: unknown; constraint?: unknown } | null;
  return pg?.code === "23505" && pg.constraint === REVISION_TAKEN;
}

async function revisionKind(
  social: SocialTransaction,
  input: PostInput,
  authorIdentityId: string,
  verifiedCreator: boolean,
  kind: PostKind,
): Promise<PostKind> {
  if (input.revisionOf === null) return kind;
  const prior = await readRecord(social, input.revisionOf, { lock: true });
  if (
    !prior ||
    prior.authorIdentityId !== authorIdentityId ||
    prior.launchId !== input.launchId ||
    prior.moderationState !== "public" ||
    (prior.kind !== "community_thesis" && !verifiedCreator)
  ) {
    throw new LaunchpadMutationError("LAUNCHPAD_FORBIDDEN");
  }
  if (!prior.current) throw new LaunchpadMutationError("LAUNCHPAD_CONFLICT");
  return prior.kind;
}

/**
 * `social_post`: a Privy session or a Wallet Proof writes one post record
 * (spec §6.9) through the shared launchpad mutation guard, in one transaction
 * with the proof's consumption.
 *
 * - `prepare`, outside the transaction: a disclosed wallet that is not the
 *   writer's is refused (403) before anything is read; otherwise the server
 *   verifies it against blast-infra's holder snapshot within one deadline.
 *   An outage makes it `unavailable`, never the write fail.
 * - In the transaction the launch must be canonical in the chain views (404
 *   otherwise; 503 while the views index no checkpoint or another
 *   deployment). A creator kind is kept only when the writer's wallet is the
 *   launch's creator in the views (AC-098); otherwise the post is stored as a
 *   community thesis, which needs a stance (400 `LAUNCHPAD_STANCE_REQUIRED`).
 *   A revision (`revisionOf`) must name the author's own public record of the
 *   same launch (403) that is still its post's current one (409); it keeps
 *   that record's stored kind, is a new record, and the old one stays for
 *   audit.
 * - The record is inserted at server time under the author's opaque identity,
 *   and its search row replaces the revised record's.
 *
 * Any refusal rolls everything back and leaves the proof unspent.
 */
export function postMutation(
  dependencies: PostMutationDependencies,
): LaunchpadMutationDefinition<PreparedPost, PostRecord> {
  const createId = dependencies.createId ?? randomUUID;
  const limits = dependencies.limits ?? SOCIAL_LIMITS;
  return {
    action: "social_post",
    fields: POST_FIELDS,
    parse: (input) => ({ ...parsePostInput(input, limits), holderProof: null }),
    rateLimit: {
      bucket: "launchpad_social_post",
      subject: ({ ip }) => ({ ip }),
    },
    async prepare(input, { actor }) {
      const wallet = input.disclosure.walletAddress;
      if (wallet === null)
        return { ...input, holderProof: { verification: "not_requested" } };
      if (!ownsDisclosedWallet(actor, input))
        throw new LaunchpadMutationError("LAUNCHPAD_FORBIDDEN");
      let holderProof: HolderProof = { verification: "unavailable" };
      if (dependencies.holderProof) {
        try {
          holderProof = await dependencies.holderProof.prove(
            input.launchId,
            wallet,
          );
        } catch {
          holderProof = { verification: "unavailable" };
        }
      }
      return { ...input, holderProof };
    },
    authorize: async ({ actor, input }) => ownsDisclosedWallet(actor, input),
    async write({ actor, input, transaction }) {
      const social = transaction.forModule("launchpad-social");
      const check = await checkLaunch(social, input.launchId);
      if (check.kind === "unindexed")
        throw new LaunchpadMutationError("LAUNCHPAD_UNAVAILABLE");
      const position = check.kind === "canonical" ? check.launch : check;
      const { expected } = dependencies;
      if (
        expected &&
        (position.network !== expected.network ||
          position.deployment !== expected.deployment)
      ) {
        throw new LaunchpadMutationError("LAUNCHPAD_UNAVAILABLE");
      }
      if (check.kind === "unknown")
        throw new LaunchpadMutationError("LAUNCHPAD_NOT_FOUND");
      const { launch } = check;
      // AC-098: a creator kind only from the launch's authoritative creator recipient; otherwise a community thesis.
      const verifiedCreator =
        actor.walletAddress !== null && actor.walletAddress === launch.creator;
      let kind: PostKind = verifiedCreator ? input.kind : "community_thesis";

      const authorIdentityId = await authorIdentity(
        social,
        identityOf(actor),
        createId,
      );
      kind = await revisionKind(
        social,
        input,
        authorIdentityId,
        verifiedCreator,
        kind,
      );
      if (input.stance === null && kind !== "creator_update") {
        throw new LaunchpadMutationError("LAUNCHPAD_STANCE_REQUIRED");
      }

      // A proof read for another coin than the launch's own proves nothing here.
      const proof = input.holderProof ?? { verification: "unavailable" };
      const holderProof: HolderProof =
        "coinType" in proof && proof.coinType !== launch.coinType
          ? { verification: "unavailable" }
          : proof;

      let record: PostRecord;
      try {
        record = await insertPost(social, {
          recordId: createId(),
          revisionOf: input.revisionOf,
          authorIdentityId,
          input: { ...input, kind },
          holderProof,
          launch,
        });
      } catch (error) {
        if (isRevisionTaken(error))
          throw new LaunchpadMutationError("LAUNCHPAD_CONFLICT");
        throw error;
      }
      if (input.revisionOf !== null)
        await removeSearchDocument(social, input.revisionOf);
      await materializeSearchDocument(social, record, limits);
      return record;
    },
    present: (record) => ({ post: publicPost(record) }),
  };
}

export function postHandler(
  dependencies: PostMutationDependencies,
  mutation: LaunchpadMutationDependencies,
): (request: Request, client: ClientAddress) => Promise<Response> {
  return createLaunchpadMutationHandler(postMutation(dependencies), mutation);
}
