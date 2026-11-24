import { z } from "zod";
// CCTP messages as the relayer worker reads them: the attested bytes Circle
// returns (V1 and V2 layouts, big-endian, as Circle's contracts and Sui's
// `message_transmitter::message` decode them), the burn checks that decide
// `invalid_burn` (spec A-008), and the key Sui's message transmitter stores a
// used nonce under. The registration's `sui_address` and `amount` are
// unauthenticated hints (`RegistrationHints`): nothing here compares the
// message with them to refuse a burn; the mint goes to the attested recipient
// for the attested amount.

import { bcs } from "@mysten/sui/bcs";
import { fromBase58, fromHex, toHex } from "@mysten/sui/utils";
import { keccak_256 } from "@noble/hashes/sha3.js";

import {
  CCTP_SOURCE_DOMAINS,
  SUI_CCTP_DOMAIN,
  type BridgeForwarding,
  type BridgeSource,
  type BridgeTransfer,
} from "./contracts.ts";

/** A message's format version: 0 is CCTP V1, 1 is CCTP V2. */
export type CctpMessageVersion = 0 | 1;

const ZERO32 = `0x${"0".repeat(64)}`;
const U64_MAX = (1n << 64n) - 1n;

/** 32 bytes as `0x` + 64 lowercase hex: a CCTP `bytes32` address. */
function word(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/**
 * Each source chain's USDC as the burn message's `burnToken` (`bytes32`),
 * mainnet only (checked 2026-10-02 against Circle's USDC address list): an
 * EVM token left-padded, the Solana mint's 32 bytes.
 */
export const SOURCE_USDC_BURN_TOKEN: Readonly<Record<BridgeSource, string>> = Object.freeze({
  ethereum: word("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
  arbitrum: word("0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
  base: word("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
  solana: `0x${toHex(fromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))}`,
});

/**
 * Each source chain's Circle TokenMessenger, the only valid `sender` of a burn
 * message, by message version (mainnet; checked 2026-10-02 against Circle's
 * contract lists: V1 `TokenMessenger` per chain and Solana's V1
 * `TokenMessengerMinter` program; V2 `TokenMessengerV2`, one address on the
 * EVM chains, and Solana's V2 program). Re-verify on activation day.
 */
export const SOURCE_TOKEN_MESSENGER: Readonly<
  Record<CctpMessageVersion, Readonly<Record<BridgeSource, string>>>
> = Object.freeze({
  0: Object.freeze({
    ethereum: word("0xbd3fa81b58ba92a82136038b25adec7066af3155"),
    arbitrum: word("0x19330d10d9cc8751218eaf51e8885d058642e08a"),
    base: word("0x1682ae6375c4e4a97e4b583bc394c861a46d8962"),
    solana: `0x${toHex(fromBase58("CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3"))}`,
  }),
  1: Object.freeze({
    ethereum: word("0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"),
    arbitrum: word("0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"),
    base: word("0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"),
    solana: `0x${toHex(fromBase58("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"))}`,
  }),
});

/** The burn message carried as a CCTP message's body (TokenMessenger's `BurnMessage`). */
export type CctpBurnBody = Readonly<{
  version: number;
  burnToken: string;
  mintRecipient: string;
  amount: bigint;
  messageSender: string;
}>;

/** One decoded CCTP message. Addresses are `0x` + 64 lowercase hex; `nonce` is its bytes in hex (8 for V1, 32 for V2). */
export type CctpMessage = Readonly<{
  version: CctpMessageVersion;
  sourceDomain: number;
  destinationDomain: number;
  nonce: string;
  sender: string;
  recipient: string;
  destinationCaller: string;
  /** V2 only. */
  minFinalityThreshold: number | null;
  /** V2 only. */
  finalityThresholdExecuted: number | null;
  /** Null when the body is not a burn message of the same version. */
  body: CctpBurnBody | null;
  /** The message as Circle returned it, `0x` + lowercase hex. */
  hex: string;
}>;

/** Bytes that are not a CCTP message; never carries them. */
export class CctpMessageError extends Error {
  constructor() {
    super("The bytes are not a CCTP message.");
    this.name = "CctpMessageError";
  }
}

const HEX = /^0x([0-9a-fA-F]{2})+$/;

/**
 * The V1 and V2 layouts (Circle's `MessageV1`/`MessageV2`; Sui's `message.move`
 * for V1): the nonce's size, where the body starts, and the burn body's fixed
 * size (V1 exactly 132 bytes; V2 a 228-byte prefix that hook data may follow).
 */
const LAYOUT = {
  0: { nonce: 8, body: 116, burnBody: 132 },
  1: { nonce: 32, body: 148, burnBody: 228 },
} as const;

function u32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, false);
}

function bytes32(bytes: Uint8Array, at: number): string {
  return `0x${toHex(bytes.subarray(at, at + 32))}`;
}

function uint256(bytes: Uint8Array, at: number): bigint {
  return BigInt(`0x${toHex(bytes.subarray(at, at + 32))}`);
}

/** Decodes Circle's `message` hex. Throws `CctpMessageError` for anything shorter than its header or of an unknown version. */
export function decodeCctpMessage(hex: string): CctpMessage {
  if (!z.string().regex(HEX).safeParse(hex).success) throw new CctpMessageError();
  const bytes = fromHex(hex.slice(2));
  if (bytes.length < 4) throw new CctpMessageError();
  const version = u32(bytes, 0);
  if (version !== 0 && version !== 1) throw new CctpMessageError();
  const layout = LAYOUT[version];
  if (bytes.length < layout.body) throw new CctpMessageError();
  const nonceEnd = 12 + layout.nonce;
  const body = bytes.subarray(layout.body);
  return Object.freeze({
    version,
    sourceDomain: u32(bytes, 4),
    destinationDomain: u32(bytes, 8),
    nonce: `0x${toHex(bytes.subarray(12, nonceEnd))}`,
    sender: bytes32(bytes, nonceEnd),
    recipient: bytes32(bytes, nonceEnd + 32),
    destinationCaller: bytes32(bytes, nonceEnd + 64),
    minFinalityThreshold: version === 1 ? u32(bytes, 140) : null,
    finalityThresholdExecuted: version === 1 ? u32(bytes, 144) : null,
    body:
      body.length >= layout.burnBody && u32(body, 0) === version
        ? Object.freeze({
            version: u32(body, 0),
            burnToken: bytes32(body, 4),
            mintRecipient: bytes32(body, 36),
            amount: uint256(body, 68),
            messageSender: bytes32(body, 100),
          })
        : null,
    hex: hex.toLowerCase(),
  });
}

/** Why a burn can never be minted for this transfer: each is `invalid_burn` (spec A-008). */
export type BurnProblem =
  | "destination_domain"
  | "source_domain"
  | "message_sender"
  | "burn_message"
  | "burn_token"
  | "mint_recipient"
  | "amount"
  | "destination_caller";

/** Who relays: the relayer key's address, and the forwarding mode. */
export type BurnContext = Readonly<{ relayer: string; forwarding: BridgeForwarding }>;

/**
 * The checks that make a burn `invalid_burn` (it is never minted; spec A-008):
 *
 * - the destination domain is Sui's (8), and the source domain the transfer's;
 * - the sender is the source's Circle TokenMessenger for the message version
 *   (anything else is a generic message, which Sui's minter refuses);
 * - a burn body of the same version, burning the source's USDC;
 * - a mint recipient that is neither zero nor the relayer itself (the relayer
 *   must never mint to itself: its key moves coins only as gas);
 * - an amount in (0, u64::MAX] (Sui mints a u64);
 * - in `blast` mode, a destination caller equal to the relayer: the quote pins
 *   every burn to it, and a zero-caller burn is not ours to pay for (anyone,
 *   the user included, can receive it).
 *
 * The recipient and amount are never compared with the registration: those
 * are hints (`registrationDiffers` only logs).
 */
export function burnProblems(
  message: CctpMessage,
  source: BridgeSource,
  context: BurnContext,
): BurnProblem[] {
  const problems: BurnProblem[] = [];
  const relayer = context.relayer.toLowerCase();
  if (message.destinationDomain !== SUI_CCTP_DOMAIN) problems.push("destination_domain");
  if (message.sourceDomain !== CCTP_SOURCE_DOMAINS[source]) problems.push("source_domain");
  if (message.sender !== SOURCE_TOKEN_MESSENGER[message.version][source])
    problems.push("message_sender");
  if (context.forwarding === "blast" && message.destinationCaller !== relayer)
    problems.push("destination_caller");
  const body = message.body;
  if (!body) {
    problems.push("burn_message");
    return problems;
  }
  if (body.burnToken !== SOURCE_USDC_BURN_TOKEN[source]) problems.push("burn_token");
  if (body.mintRecipient === ZERO32 || body.mintRecipient === relayer)
    problems.push("mint_recipient");
  if (body.amount <= 0n || body.amount > U64_MAX) problems.push("amount");
  return problems;
}

/**
 * What a registration says about its burn: unauthenticated hints. Anyone who
 * sees a burn can register it first, with any address or amount. They are
 * logged when they differ from the attested message, and never decide
 * anything else.
 */
export type RegistrationHints = Readonly<{ hintedSuiAddress: string; hintedAmount: bigint }>;

export function registrationHints(
  transfer: Pick<BridgeTransfer, "suiAddress" | "amount">,
): RegistrationHints {
  return Object.freeze({
    hintedSuiAddress: transfer.suiAddress.toLowerCase(),
    hintedAmount: BigInt(transfer.amount),
  });
}

/** Whether the attested message differs from the registration's hints (logged as `registration_differs`, never refused). */
export function registrationDiffers(message: CctpMessage, hints: RegistrationHints): boolean {
  return (
    message.body?.mintRecipient !== hints.hintedSuiAddress ||
    message.body?.amount !== hints.hintedAmount
  );
}

/**
 * Circle's decoded view of a message it has not attested yet (`decodedMessage`):
 * the fields the early checks read, normalized. Null fields were absent or
 * unreadable and are not checked.
 */
export type CircleDecodedMessage = Readonly<{
  sourceDomain: number | null;
  destinationDomain: number | null;
  sender: string | null;
  destinationCaller: string | null;
  burnToken: string | null;
  mintRecipient: string | null;
  amount: bigint | null;
  minFinalityThreshold: number | null;
}>;

/** A Circle `Address` (hex of up to 32 bytes, any case, or a base58 Solana key) as `bytes32`, or null. */
export function circleAddressWord(value: unknown): string | null {
  const parsed = z
    .union([
      z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
      z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    ])
    .safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.startsWith("0x")) return word(parsed.data);
  try {
    const key = fromBase58(parsed.data);
    return key.length === 32 ? `0x${toHex(key)}` : null;
  } catch {
    return null;
  }
}

/**
 * The early checks on Circle's decoded message, before any attestation (spec
 * A-008: "as soon as Circle returns the decoded message"): the same classes as
 * `burnProblems` that the decoded view carries. A field Circle did not give is
 * not checked; the attested bytes are checked in full.
 */
export function decodedBurnProblems(
  decoded: CircleDecodedMessage,
  source: BridgeSource,
  context: BurnContext,
): BurnProblem[] {
  const problems: BurnProblem[] = [];
  const relayer = context.relayer.toLowerCase();
  const tokenMessengers: readonly string[] = [
    SOURCE_TOKEN_MESSENGER[0][source],
    SOURCE_TOKEN_MESSENGER[1][source],
  ];
  if (decoded.destinationDomain !== null && decoded.destinationDomain !== SUI_CCTP_DOMAIN)
    problems.push("destination_domain");
  if (decoded.sourceDomain !== null && decoded.sourceDomain !== CCTP_SOURCE_DOMAINS[source])
    problems.push("source_domain");
  if (decoded.sender !== null && !tokenMessengers.includes(decoded.sender))
    problems.push("message_sender");
  if (
    context.forwarding === "blast" &&
    decoded.destinationCaller !== null &&
    decoded.destinationCaller !== relayer
  )
    problems.push("destination_caller");
  if (decoded.burnToken !== null && decoded.burnToken !== SOURCE_USDC_BURN_TOKEN[source])
    problems.push("burn_token");
  if (
    decoded.mintRecipient !== null &&
    (decoded.mintRecipient === ZERO32 || decoded.mintRecipient === relayer)
  )
    problems.push("mint_recipient");
  if (decoded.amount !== null && (decoded.amount <= 0n || decoded.amount > U64_MAX))
    problems.push("amount");
  return problems;
}

/**
 * The key Sui's V1 message transmitter stores a used `(source_domain, nonce)`
 * under in `State.used_nonces`: `keccak256(bcs(u32) ‖ "-" ‖ bcs(u64))` as an
 * address (`state::generate_used_nonce_key`).
 */
export function usedNonceKeyV1(sourceDomain: number, nonce: bigint): string {
  const preimage = new Uint8Array([
    ...bcs.u32().serialize(sourceDomain).toBytes(),
    "-".charCodeAt(0),
    ...bcs.u64().serialize(nonce).toBytes(),
  ]);
  return `0x${toHex(keccak_256(preimage))}`;
}

/** A V1 message's nonce as the u64 Sui stores. */
export function v1Nonce(message: CctpMessage): bigint {
  if (message.version !== 0) throw new CctpMessageError();
  return BigInt(message.nonce);
}
