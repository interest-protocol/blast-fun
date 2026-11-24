import { z } from "zod";
import { recordPresaleMetric } from "@blast/core/modules/presale/redaction/redaction.ts";
import {
  CIRCLE_CACHE_TTL_MS,
  CIRCLE_FAILURE_TTL_MS,
  CIRCLE_RATE_LIMIT_BLOCK_MS,
  CircleUnavailableError,
  createIrisGet,
} from "@blast/core/modules/presale/bridge/circle.ts";
import { SUI_CCTP_DOMAIN } from "@blast/core/modules/presale/bridge/contracts.ts";
import {
  destinationDomain,
  type WithdrawDestination,
} from "@blast/core/modules/presale/bridge/sui-burn.ts";

/**
 * Circle's Iris reads for withdrawals out of Sui (domain 8), mainnet only:
 *
 * - `GET /v2/burn/USDC/fees/8/{destination}?forward=true` — the protocol fee
 *   (basis points) per finality threshold and the Forwarding Service's fee
 *   (`forwardFee`, USDC atoms, `low`/`med`/`high`); for Solana with
 *   `includeRecipientSetup=true`, so the fee covers creating the recipient's
 *   USDC token account. A list without `forwardFee` means Circle does not
 *   forward to that destination.
 * - `GET /v2/messages/8?transactionHash={sui digest}` — the burn's message,
 *   its attestation status and, once Circle minted on the destination,
 *   `forwardState` and `forwardTxHash`.
 *
 * The offline tests use synthetic Iris responses in `withdraw-fixtures.ts`.
 */

export type CircleForwardFee = Readonly<{
  finalityThreshold: number;
  /** The protocol fee in basis points, a decimal string. */
  minimumFeeBps: string;
  /** The Forwarding Service's fee in USDC atoms, by level; null when Circle does not forward this route. */
  forwardFee: Readonly<{ low: bigint; med: bigint; high: bigint }> | null;
}>;

export type CircleWithdrawMessage = Readonly<{
  /** `complete` once attested. */
  status: "complete" | "pending_confirmations";
  /** The attested message, `0x` + hex; null until attested. */
  message: string | null;
  /** Circle's forward state (`PENDING`, `COMPLETE`, …); null before Circle reports one. */
  forwardState: string | null;
  /** The destination's mint transaction (EVM `0x` hash, or a Solana signature); null until Circle reports it. */
  forwardTxHash: string | null;
  /** What Circle kept on the destination, USDC atoms; null until known. */
  feeExecuted: bigint | null;
  delayReason: string | null;
}>;

export type CircleWithdrawIris = Readonly<{
  forwardFees(destination: WithdrawDestination): Promise<readonly CircleForwardFee[]>;
  /** The burn's message, or null while Circle has not seen the transaction. */
  message(suiDigest: string): Promise<CircleWithdrawMessage | null>;
}>;

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ATOMS = /^(0|[1-9][0-9]{0,19})$/;
const HEX_BYTES = /^0x([0-9a-fA-F]{2})+$/;
const FORWARD_TX = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/;
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const bpsSchema = z.union([
  z.string().regex(DECIMAL),
  z
    .number()
    .nonnegative()
    .max(10_000)
    .transform((value) =>
      /e/i.test(String(value)) ? value.toFixed(20).replace(/\.?0+$/, "") : String(value),
    )
    .pipe(z.string().regex(DECIMAL)),
]);
const atomsSchema = z
  .union([z.number().int().safe().nonnegative(), z.string().regex(ATOMS)])
  .transform(BigInt);
const forwardFeesSchema = z.array(
  z.object({
    finalityThreshold: z.number().int().safe(),
    minimumFee: bpsSchema,
    forwardFee: z.object({ low: atomsSchema, med: atomsSchema, high: atomsSchema }).nullish(),
  }),
);
const messagesSchema = z.object({ messages: z.array(z.unknown()) });
const messageSchema = z.object({
  status: z.unknown().optional(),
  message: z.unknown().optional(),
  forwardTxHash: z.unknown().optional(),
  forwardState: z.unknown().optional(),
  delayReason: z.unknown().optional(),
  decodedMessage: z.unknown().optional(),
});
const executedFeeSchema = z.object({
  decodedMessageBody: z.object({ feeExecuted: z.string().regex(ATOMS).transform(BigInt) }),
});

export function parseForwardFees(body: unknown): readonly CircleForwardFee[] {
  const parsed = forwardFeesSchema.safeParse(body);
  if (!parsed.success) throw new CircleUnavailableError("malformed");
  return Object.freeze(
    parsed.data.map((entry) =>
      Object.freeze({
        finalityThreshold: entry.finalityThreshold,
        minimumFeeBps: entry.minimumFee,
        forwardFee: entry.forwardFee ? Object.freeze(entry.forwardFee) : null,
      }),
    ),
  );
}

function matchedText(value: unknown, pattern: RegExp): string | null {
  const parsed = z.string().regex(pattern).safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The first message of `/v2/messages/8`'s answer (a Sui burn emits one), or null when there is none yet. */
export function parseWithdrawMessage(body: unknown): CircleWithdrawMessage | null {
  if (body === null) return null;
  const envelope = messagesSchema.safeParse(body);
  if (!envelope.success) throw new CircleUnavailableError("malformed");
  if (envelope.data.messages[0] === undefined) return null;
  const parsed = messageSchema.safeParse(envelope.data.messages[0]);
  if (!parsed.success) throw new CircleUnavailableError("malformed");
  const first = parsed.data;
  const status = first.status === "complete" ? "complete" : "pending_confirmations";
  const message = matchedText(first.message, HEX_BYTES)?.toLowerCase() ?? null;
  const forwardTxHash = matchedText(first.forwardTxHash, FORWARD_TX);
  const decoded = executedFeeSchema.safeParse(first.decodedMessage);
  const feeExecuted = decoded.success ? decoded.data.decodedMessageBody.feeExecuted : null;
  return Object.freeze({
    status,
    message: status === "complete" ? message : null,
    forwardState: matchedText(first.forwardState, /^[A-Z_]{1,32}$/),
    forwardTxHash,
    feeExecuted,
    delayReason: matchedText(first.delayReason, /^[a-z_]{1,64}$/),
  });
}

export function createCircleWithdrawIris(
  options: Readonly<{ fetch?: typeof globalThis.fetch; timeoutMs?: number }> = {},
): CircleWithdrawIris {
  const get = createIrisGet(options);
  return Object.freeze({
    async forwardFees(destination: WithdrawDestination) {
      const setup = destination === "solana" ? "&includeRecipientSetup=true" : "";
      return parseForwardFees(
        await get(
          `/v2/burn/USDC/fees/${SUI_CCTP_DOMAIN}/${destinationDomain(destination)}?forward=true${setup}`,
        ),
      );
    },
    async message(suiDigest: string) {
      if (!z.string().regex(DIGEST).safeParse(suiDigest).success)
        throw new CircleUnavailableError("malformed");
      return parseWithdrawMessage(
        await get(`/v2/messages/${SUI_CCTP_DOMAIN}?transactionHash=${suiDigest}`, "null"),
      );
    },
  });
}

/** Circle could not answer; `retryAfterSeconds` is when the next attempt is allowed. */
export class CircleWithdrawUnavailable extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterMs: number) {
    super("Circle Iris API unavailable.");
    this.name = "CircleWithdrawUnavailable";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  }
}

/** How long one burn's message answer is reused per instance. */
export const CIRCLE_MESSAGE_TTL_MS = 5_000;

type Entry =
  | { kind: "value"; value: unknown; until: number }
  | { kind: "failure"; until: number }
  | { kind: "pending"; promise: Promise<unknown> };

/**
 * The per-instance facade the withdrawal routes read, as `createCachedCircle`
 * is the deposit quote's: one request in flight per key, fee lists reused for
 * `ttlMs` (four destinations: at most four requests per 30 s), a burn's
 * message for `messageTtlMs`, a failure not repeated for `failureTtlMs`, and
 * after a 429 nothing is sent for Circle's 5-minute block. Every failure is a
 * `CircleWithdrawUnavailable`.
 */
export function createCachedCircleWithdraw(
  iris: CircleWithdrawIris,
  options: Readonly<{
    now?: () => number;
    ttlMs?: number;
    messageTtlMs?: number;
    failureTtlMs?: number;
    rateLimitBlockMs?: number;
    maxEntries?: number;
  }> = {},
): CircleWithdrawIris {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CIRCLE_CACHE_TTL_MS;
  const messageTtlMs = options.messageTtlMs ?? CIRCLE_MESSAGE_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? CIRCLE_FAILURE_TTL_MS;
  const rateLimitBlockMs = options.rateLimitBlockMs ?? CIRCLE_RATE_LIMIT_BLOCK_MS;
  const maxEntries = options.maxEntries ?? 1_000;
  const entries = new Map<string, Entry>();
  let blockedUntil = 0;

  async function cached<T>(key: string, life: number, load: () => Promise<T>): Promise<T> {
    const at = now();
    if (at < blockedUntil) throw new CircleWithdrawUnavailable(blockedUntil - at);
    const entry = entries.get(key);
    if (entry?.kind === "pending") return entry.promise as Promise<T>;
    if (entry?.kind === "value" && at < entry.until) return entry.value as T;
    if (entry?.kind === "failure" && at < entry.until)
      throw new CircleWithdrawUnavailable(entry.until - at);
    // Messages are per burn: keep the map bounded (oldest first).
    if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    const promise = load().then(
      (value) => {
        entries.set(key, { kind: "value", value, until: now() + life });
        return value;
      },
      (error: unknown) => {
        const kind = error instanceof CircleUnavailableError ? error.kind : "unavailable";
        recordPresaleMetric("presale.bridge.circle", {
          outcome: "error",
          kind,
          read: key.startsWith("message:") ? "withdraw_message" : key,
        });
        if (kind === "rate_limited") blockedUntil = now() + rateLimitBlockMs;
        const until = now() + (kind === "rate_limited" ? rateLimitBlockMs : failureTtlMs);
        entries.set(key, { kind: "failure", until });
        throw new CircleWithdrawUnavailable(until - now());
      },
    );
    entries.set(key, { kind: "pending", promise });
    return promise;
  }

  return Object.freeze({
    forwardFees: (destination: WithdrawDestination) =>
      cached(`forward_fees:${destination}`, ttlMs, () => iris.forwardFees(destination)),
    message: (suiDigest: string) =>
      cached(`message:${suiDigest}`, messageTtlMs, () => iris.message(suiDigest)),
  });
}
