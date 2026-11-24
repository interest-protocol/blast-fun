/**
 * Every intent Blast's gas pool sponsors, with the rules each one follows. The
 * route's request schema, the service, the presale policy, execute and the
 * reservation store derive from this table. The only other copy is the database's CHECK constraints on
 * `presale_sponsor_reservations`, which the sponsor integration test compares
 * with it.
 */

/**
 * A call a presale intent sponsors. `sender`: the argument that must hold the
 * sender's address, and the role refusals name it by; `null` when no argument does.
 */
export type SponsorCall = Readonly<{
  target: string;
  sender: Readonly<{ argument: number; role: "participant" | "beneficiary" }> | null;
}>;

/**
 * A presale intent's calls, on the presale's package or its vault's. Argument 0
 * of each is the presale (the round for vault calls).
 */
type PresaleSponsorPolicy = Readonly<{
  kind: "presale";
  package: "presale" | "vault";
  calls: readonly [SponsorCall, ...SponsorCall[]];
}>;

type SponsorIntentRule = Readonly<
  {
    /**
     * `browser`: the public sponsor route accepts it. `server`: only authenticated server workflows build it.
     * A `commit` may also come in-process from the commit route (`sponsorServerCommit`), which skips its target policy.
     */
    builder: "browser" | "server";
    /**
     * The target policy that checks the kind. `presale` intents name their presale;
     * `trusted` kinds were built by the server itself and skip the net-storage cap.
     */
    policy: PresaleSponsorPolicy | Readonly<{ kind: "withdraw" | "bridge_withdraw" | "trusted" }>;
    /** Counted against `presale_sponsor_exec`: checked when sponsored, consumed when executed. */
    dailyLimit: boolean;
    /** What execute records once the chain confirms success. */
    afterSuccess?: "record_commit";
    /** The intent may carry a durable reservation id, which recovers its first answer. */
    recovery?: "keyed";
    /** A retained plan may be replaced once execute can no longer submit it. */
    replaceable?: true;
  } & (
    | {
        /** Calls Blast's contracts: sponsoring and executing need the signing identity. */
        blastContracts: true;
        /** The presale pause bit the signing identity must find clear. */
        pauseBit?: "Commit";
      }
    | { blastContracts: false; pauseBit?: never }
  )
>;

/** Kept in this order: the generated request schema lists the public intents as they appear here. */
export const SPONSOR_INTENTS = {
  commit: {
    builder: "browser",
    policy: {
      kind: "presale",
      package: "presale",
      calls: [
        { target: "blast_presale::commit_open", sender: null },
        { target: "blast_presale::commit_allowlisted", sender: null },
        { target: "blast_presale::commit_uncapped", sender: null },
      ],
    },
    dailyLimit: true,
    blastContracts: true,
    pauseBit: "Commit",
    afterSuccess: "record_commit",
  },
  claim: {
    builder: "browser",
    policy: {
      kind: "presale",
      package: "presale",
      // `blast_presale::claim(presale, package_version, participant, clock)`.
      calls: [{ target: "blast_presale::claim", sender: { argument: 2, role: "participant" } }],
    },
    dailyLimit: true,
    blastContracts: true,
  },
  settle: {
    builder: "browser",
    policy: {
      kind: "presale",
      package: "presale",
      calls: [{ target: "blast_presale::settle", sender: null }],
    },
    dailyLimit: true,
    blastContracts: true,
  },
  cancel: {
    builder: "browser",
    policy: {
      kind: "presale",
      package: "presale",
      calls: [{ target: "blast_presale::cancel_unlaunched", sender: null }],
    },
    dailyLimit: true,
    blastContracts: true,
  },
  reward_claim: {
    builder: "browser",
    policy: {
      kind: "presale",
      package: "vault",
      // `holder_rewards::claim(round, package_version, index, beneficiary, meme_amount, quote_amount, proof, clock)`.
      calls: [{ target: "holder_rewards::claim", sender: { argument: 3, role: "beneficiary" } }],
    },
    dailyLimit: true,
    blastContracts: true,
  },
  withdraw: { builder: "browser", policy: { kind: "withdraw" }, dailyLimit: true, blastContracts: false },
  // Social R3-31: the social path's own daily cap counts trades, never the presale budget.
  trade: { builder: "server", policy: { kind: "trusted" }, dailyLimit: false, blastContracts: true },
  bridge_withdraw: {
    builder: "server",
    policy: { kind: "bridge_withdraw" },
    dailyLimit: true,
    blastContracts: false,
    recovery: "keyed",
    replaceable: true,
  },
  create: {
    builder: "server",
    policy: { kind: "trusted" },
    dailyLimit: true,
    blastContracts: true,
    replaceable: true,
  },
  vesting: { builder: "server", policy: { kind: "trusted" }, dailyLimit: true, blastContracts: true },
  creator_caps: { builder: "server", policy: { kind: "trusted" }, dailyLimit: true, blastContracts: true },
  launch_claim: { builder: "server", policy: { kind: "trusted" }, dailyLimit: true, blastContracts: true },
} as const satisfies Record<string, SponsorIntentRule>;

type Intents = typeof SPONSOR_INTENTS;
type IntentsWhere<Rule> = { [I in SponsorIntent]: Intents[I] extends Rule ? I : never }[SponsorIntent];

/** Every sponsored intent. */
export type SponsorIntent = keyof Intents;
/** The intents the public sponsor route accepts. */
export type PublicSponsorIntent = IntentsWhere<{ builder: "browser" }>;
/** The intents that act on one presale and name it. */
export type PresaleSponsorIntent = IntentsWhere<{ policy: { kind: "presale" } }>;
/** The intents that may carry a durable reservation id. */
export type KeyedSponsorIntent = IntentsWhere<{ recovery: "keyed" }>;
/** The intents whose retained plan may be replaced. */
export type ReplaceableSponsorIntent = IntentsWhere<{ replaceable: true }>;
type SponsorPolicyKind = SponsorIntentRule["policy"]["kind"];

/** What sponsoring and executing an intent ask of the deployment. */
type SponsorSigningCheck =
  | Readonly<{ identity: false }>
  | Readonly<{ identity: true; pauseBit: "Commit" | null }>;

function rule(intent: SponsorIntent): SponsorIntentRule {
  return SPONSOR_INTENTS[intent];
}

const INTENTS = Object.keys(SPONSOR_INTENTS) as SponsorIntent[];

/** The public route's intents, in registry order. */
export const PUBLIC_SPONSOR_INTENTS = INTENTS.filter(
  (intent) => rule(intent).builder === "browser",
) as [PublicSponsorIntent, ...PublicSponsorIntent[]];

export function sponsorPolicyKind(intent: SponsorIntent): SponsorPolicyKind {
  return rule(intent).policy.kind;
}

/** The calls a presale intent sponsors, and whose package they are on. */
export function presalePolicy(intent: PresaleSponsorIntent): PresaleSponsorPolicy {
  return SPONSOR_INTENTS[intent].policy;
}

/** Whether a request for `intent` names its presale. */
export function namesPresale(intent: SponsorIntent): intent is PresaleSponsorIntent {
  return sponsorPolicyKind(intent) === "presale";
}

/** Whether the sponsor caps the storage the kind leaves it paying for (`SPONSOR_MAX_NET_STORAGE_MIST`). */
export function capsNetStorage(intent: SponsorIntent): boolean {
  return sponsorPolicyKind(intent) !== "trusted";
}

/** Whether `presale_sponsor_exec` counts the intent. */
export function countsDailyExecution(intent: SponsorIntent): boolean {
  return rule(intent).dailyLimit;
}

/** Gate only, or the signing identity with its pause bit. Execute checks nothing when `identity` is false. */
export function signingCheck(intent: SponsorIntent): SponsorSigningCheck {
  const entry = rule(intent);
  return entry.blastContracts
    ? { identity: true, pauseBit: entry.pauseBit ?? null }
    : { identity: false };
}

/** Whether the intent may carry a durable reservation id. */
export function recoversByKey(intent: SponsorIntent): intent is KeyedSponsorIntent {
  return rule(intent).recovery === "keyed";
}

/** Whether execute records a successful transaction as a presale commit. */
export function recordsCommit(intent: SponsorIntent): boolean {
  return rule(intent).afterSuccess === "record_commit";
}
