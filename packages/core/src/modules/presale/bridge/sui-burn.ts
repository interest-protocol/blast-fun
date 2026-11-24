import { z } from "zod";
// The Sui side of a withdrawal out of Blast (social coins, withdraw to another
// chain): USDC burned on Sui with Circle's CCTP V2 and minted on a destination
// chain by Circle's Forwarding Service, so the reader needs no wallet there.
//
// The burn is the three-call PTB of Circle's `circlefin/sui-cctp` (master
// `b23b83b`, "CCTP V2 on Sui", 2026-10-05: `scripts/sui/ptbV2.ts`
// `addDepositForBurnV2`; Circle's "CCTP Sui packages and interfaces" and the
// "Transfer USDC between Sui and Arc" quickstart), checked against the
// mainnet packages' normalized signatures on 2026-10-06:
//
//   1. `token_messenger_minter_v2::deposit_for_burn::deposit_for_burn<USDC>(
//        coin, destination_domain: u32, mint_recipient: address,
//        destination_caller: address, max_fee: u256,
//        min_finality_threshold: u32, hook_data: vector<u8>, &TMM State)`
//      → (BurnReceipt<USDC>, Coin<USDC>)
//   2. `stablecoin_handler::handler::burn(&Handler State, receipt, coin,
//        &DenyList, &mut Treasury<USDC>)` → CompleteBurnTicket<USDC, Auth>
//   3. `token_messenger_minter_v2::deposit_for_burn::complete_burn<USDC,
//        handler::Auth>(ticket, &TMM State, &MT State)`
//
// Every shared object is passed fully resolved (its initial shared version
// and mutability as the signatures take it), so building needs no node.

import { bcs } from "@mysten/sui/bcs";
import {
  coinWithBalance,
  Inputs,
  Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import {
  fromBase58,
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
  toHex,
} from "@mysten/sui/utils";
import { keccak_256 } from "@noble/hashes/sha3.js";

import type { PresaleSharedObject } from "../deployment/contracts.ts";
import { CCTP_SOURCE_DOMAINS, type BridgeSource, type SuiCctpIds } from "./contracts.ts";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/** The deployment identity's Sui CCTP V2 ids a burn needs. */
export type SuiBurnIds = Readonly<{
  /** `token_messenger_minter_v2`'s package id. */
  tokenMessengerMinter: string;
  /** `stablecoin_handler`'s package id. */
  stablecoinHandler: string;
  tmmState: PresaleSharedObject;
  mtState: PresaleSharedObject;
  handlerState: PresaleSharedObject;
  usdcTreasury: PresaleSharedObject;
  denyList: PresaleSharedObject;
  usdcType: string;
}>;

/**
 * Circle's CCTP V2 on Sui mainnet, as `circlefin/sui-cctp` (master `b23b83b`)
 * publishes it: the packages and each shared object at its initial shared
 * version. The runtime reads the
 * deployment identity's `cctp` block, never these; they are the reference the
 * operator's identity is written from and the tests check against.
 */
export const SUI_CCTP_V2_MAINNET: SuiBurnIds = Object.freeze({
  tokenMessengerMinter: "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830",
  stablecoinHandler: "0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf",
  tmmState: Object.freeze({
    objectId: "0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167",
    initialSharedVersion: "824760982",
  }),
  mtState: Object.freeze({
    objectId: "0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c",
    initialSharedVersion: "824760979",
  }),
  handlerState: Object.freeze({
    objectId: "0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41",
    initialSharedVersion: "824760983",
  }),
  usdcTreasury: Object.freeze({
    objectId: "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
    initialSharedVersion: "313333795",
  }),
  denyList: Object.freeze({ objectId: `0x${"0".repeat(61)}403`, initialSharedVersion: "65624845" }),
  usdcType: USDC_COIN_TYPE,
});

/** MessageTransmitter V2's package on Sui mainnet (the identity's `cctp.messageTransmitter`). */
export const SUI_CCTP_V2_MAINNET_MESSAGE_TRANSMITTER =
  "0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87";

/** The burn's ids from the identity's `cctp` block; null while it lacks the V2 stablecoin handler. */
export function suiBurnIds(cctp: SuiCctpIds | null | undefined): SuiBurnIds | null {
  if (!cctp?.stablecoinHandler || !cctp.handlerState) return null;
  return Object.freeze({
    tokenMessengerMinter: normalizeSuiAddress(cctp.tokenMessengerMinter),
    stablecoinHandler: normalizeSuiAddress(cctp.stablecoinHandler),
    tmmState: cctp.tmmState,
    mtState: cctp.mtState,
    handlerState: cctp.handlerState,
    usdcTreasury: cctp.usdcTreasury,
    denyList: cctp.denyList,
    usdcType: normalizeStructTag(cctp.usdcType),
  });
}

/** Where a withdrawal can go, in the coins sheet's order (the deposit side's `CCTP_CHAINS`). */
export const WITHDRAW_DESTINATIONS = Object.freeze([
  "base",
  "arbitrum",
  "ethereum",
  "solana",
] as const satisfies readonly BridgeSource[]);
export type WithdrawDestination = (typeof WITHDRAW_DESTINATIONS)[number];

export function withdrawDestination(value: unknown): WithdrawDestination | null {
  return (WITHDRAW_DESTINATIONS as readonly unknown[]).includes(value)
    ? (value as WithdrawDestination)
    : null;
}

/** A destination's CCTP domain (Ethereum 0, Arbitrum 3, Solana 5, Base 6). */
export function destinationDomain(destination: WithdrawDestination): number {
  return CCTP_SOURCE_DOMAINS[destination];
}

/**
 * The finality a withdrawal asks for: Standard. Circle lists Sui as a source
 * with Fast Transfer "N/A" (Sui's standard attestation is already about half
 * a second), so a Fast burn would only spend the global Fast allowance.
 */
export const WITHDRAW_FINALITY_THRESHOLD = 2000;

/** Solana's mainnet USDC mint; the Forwarding Service mints to the recipient's USDC token account. */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ZERO_ADDRESS = `0x${"0".repeat(64)}`;

/** EIP-55: a mixed-case address must carry its checksum; all-lower or all-upper carries none. */
function evmChecksumOk(address: string): boolean {
  const hex = address.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const hash = toHex(keccak_256(new TextEncoder().encode(hex.toLowerCase())));
  for (let index = 0; index < 40; index += 1) {
    const char = hex[index]!;
    if (!/[a-fA-F]/.test(char)) continue;
    const upper = Number.parseInt(hash[index]!, 16) >= 8;
    if ((char === char.toUpperCase()) !== upper) return false;
  }
  return true;
}

/**
 * The recipient as typed, canonical for its chain, or null when it is not an
 * address there: an EVM address (`0x` + 40 hex, its checksum when mixed case,
 * never zero) as lowercase; a Solana key (32 bytes in base58) as typed.
 */
export function canonicalWithdrawRecipient(
  destination: WithdrawDestination,
  value: unknown,
): string | null {
  const parsed = z
    .string()
    .trim()
    .regex(destination === "solana" ? BASE58 : EVM_ADDRESS)
    .safeParse(value);
  if (!parsed.success) return null;
  const text = parsed.data;
  if (destination === "solana") {
    try {
      const key = fromBase58(text);
      return key.length === 32 && key.some((byte) => byte !== 0) ? text : null;
    } catch {
      return null;
    }
  }
  if (!evmChecksumOk(text)) return null;
  const lower = text.toLowerCase();
  return /^0x0{40}$/.test(lower) ? null : lower;
}

/** The magic Circle's Forwarding Service reads: `cctp-forward` in 24 bytes. */
const FORWARD_MAGIC = (() => {
  const bytes = new Uint8Array(24);
  bytes.set(new TextEncoder().encode("cctp-forward"));
  return bytes;
})();

/**
 * The hook that asks Circle's Forwarding Service to mint on the destination
 * (version 0, Circle's "Hook format"). An EVM recipient takes the static 32
 * bytes (`cctp-forward`, version 0, no extra data:
 * `0x636374702d666f7277617264…00`). A Solana recipient's hook asks Circle to
 * create its USDC token account when it has none: 33 bytes of Circle data,
 * `1` then the recipient's key, and the burn's `mint_recipient` is that
 * account (Circle checks the two agree).
 */
export function forwardHookData(destination: WithdrawDestination, recipient: string): Uint8Array {
  const header = new Uint8Array(32);
  header.set(FORWARD_MAGIC);
  if (destination !== "solana") return header;
  new DataView(header.buffer).setUint32(28, 33, false);
  const owner = fromBase58(recipient);
  const hook = new Uint8Array(65);
  hook.set(header);
  hook[32] = 1;
  hook.set(owner, 33);
  return hook;
}

/** Whether `hook` is the Forwarding Service's version-0 request (with or without Circle data). */
export function isForwardHook(hook: Uint8Array): boolean {
  if (hook.length < 32) return false;
  for (let index = 0; index < 24; index += 1)
    if (hook[index] !== FORWARD_MAGIC[index]) return false;
  const view = new DataView(hook.buffer, hook.byteOffset, hook.byteLength);
  return view.getUint32(24, false) === 0 && view.getUint32(28, false) === hook.length - 32;
}

/**
 * The burn's `mint_recipient` (32 bytes, `0x` + 64 hex): an EVM address
 * left-padded with zeros; for Solana, the recipient's USDC associated token
 * account (Circle's "Solana `mintRecipient`"), derived with Solana's own
 * program-address rule.
 */
export async function withdrawMintRecipient(
  destination: WithdrawDestination,
  recipient: string,
): Promise<string> {
  if (destination !== "solana") return `0x${recipient.slice(2).toLowerCase().padStart(64, "0")}`;
  const [{ findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS }, { address, getAddressEncoder }] =
    await Promise.all([import("@solana-program/token"), import("@solana/kit")]);
  const [account] = await findAssociatedTokenPda({
    owner: address(recipient),
    mint: address(SOLANA_USDC_MINT),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return `0x${toHex(Uint8Array.from(getAddressEncoder().encode(account)))}`;
}

/** One burn: what leaves the Blast wallet, where it is minted and for how much at most in fees. */
export type SuiBurnParams = Readonly<{
  destination: WithdrawDestination;
  /** USDC atoms burned on Sui. */
  amount: bigint;
  /** `0x` + 64 hex. */
  mintRecipient: string;
  /** USDC atoms Circle may keep on the destination (protocol fee + forwarding fee); strictly below `amount`. */
  maxFee: bigint;
  hookData: Uint8Array;
}>;

function shared(object: PresaleSharedObject, mutable: boolean) {
  return Inputs.SharedObjectRef({
    objectId: object.objectId,
    initialSharedVersion: object.initialSharedVersion,
    mutable,
  });
}

/** Appends the three burn calls to `tx`, burning `coin` (exactly `params.amount` of USDC). */
export function addSuiBurn(
  tx: Transaction,
  ids: SuiBurnIds,
  coin: TransactionObjectArgument,
  params: SuiBurnParams,
): void {
  const tmmState = tx.object(shared(ids.tmmState, false));
  const [receipt, returned] = tx.moveCall({
    target: `${ids.tokenMessengerMinter}::deposit_for_burn::deposit_for_burn`,
    typeArguments: [ids.usdcType],
    arguments: [
      coin,
      tx.pure.u32(destinationDomain(params.destination)),
      tx.pure.address(params.mintRecipient),
      tx.pure.address(ZERO_ADDRESS),
      tx.pure.u256(params.maxFee),
      tx.pure.u32(WITHDRAW_FINALITY_THRESHOLD),
      tx.pure.vector("u8", Array.from(params.hookData)),
      tmmState,
    ],
  });
  const [ticket] = tx.moveCall({
    target: `${ids.stablecoinHandler}::handler::burn`,
    arguments: [
      tx.object(shared(ids.handlerState, false)),
      receipt!,
      returned!,
      tx.object(shared(ids.denyList, false)),
      tx.object(shared(ids.usdcTreasury, true)),
    ],
  });
  tx.moveCall({
    target: `${ids.tokenMessengerMinter}::deposit_for_burn::complete_burn`,
    typeArguments: [ids.usdcType, `${ids.stablecoinHandler}::handler::Auth`],
    arguments: [ticket!, tmmState, tx.object(shared(ids.mtState, false))],
  });
}

/**
 * The withdrawal as a transaction from `sender`: exactly `params.amount` of
 * the sender's USDC (its coins or address balance, never the gas coin), then
 * the burn. Nothing else moves.
 */
export function suiBurnTransaction(
  ids: SuiBurnIds,
  sender: string,
  params: SuiBurnParams,
): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  const coin = tx.add(
    coinWithBalance({ type: ids.usdcType, balance: params.amount, useGasCoin: false }),
  );
  addSuiBurn(tx, ids, coin, params);
  return tx;
}

/** `deposit_for_burn::DepositForBurn`, as `complete_burn` emits it. */
const DepositForBurnBcs = bcs.struct("DepositForBurn", {
  burn_token: bcs.Address,
  amount: bcs.u256(),
  depositor: bcs.Address,
  mint_recipient: bcs.Address,
  destination_domain: bcs.u32(),
  destination_token_messenger: bcs.Address,
  destination_caller: bcs.Address,
  max_fee: bcs.u256(),
  min_finality_threshold: bcs.u32(),
  hook_data: bcs.vector(bcs.u8()),
});

/** One burn as its event reports it. Addresses are `0x` + 64 lowercase hex. */
export type DepositForBurnEvent = Readonly<{
  amount: bigint;
  depositor: string;
  mintRecipient: string;
  destinationDomain: number;
  destinationCaller: string;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: string;
}>;

/** The `DepositForBurn` events among `events` emitted by the identity's TokenMessengerMinter V2. */
export function depositForBurnEvents(
  events: readonly Readonly<{ eventType: string; bcs: Uint8Array }>[],
  ids: Pick<SuiBurnIds, "tokenMessengerMinter">,
): DepositForBurnEvent[] {
  const tmm = normalizeSuiAddress(ids.tokenMessengerMinter);
  return events.flatMap((event) => {
    try {
      const tag = parseStructTag(event.eventType);
      if (
        normalizeSuiAddress(tag.address) !== tmm ||
        tag.module !== "deposit_for_burn" ||
        tag.name !== "DepositForBurn"
      )
        return [];
      const parsed = DepositForBurnBcs.parse(event.bcs);
      return [
        Object.freeze({
          amount: BigInt(parsed.amount),
          depositor: normalizeSuiAddress(parsed.depositor),
          mintRecipient: normalizeSuiAddress(parsed.mint_recipient),
          destinationDomain: parsed.destination_domain,
          destinationCaller: normalizeSuiAddress(parsed.destination_caller),
          maxFee: BigInt(parsed.max_fee),
          minFinalityThreshold: parsed.min_finality_threshold,
          hookData: `0x${toHex(Uint8Array.from(parsed.hook_data))}`,
        }),
      ];
    } catch {
      return [];
    }
  });
}

/** What a recorded withdrawal expects its burn to have been. */
export type ExpectedBurn = Readonly<{
  sender: string;
  destination: WithdrawDestination;
  amount: bigint;
  mintRecipient: string;
  maxFee: bigint;
  hookData: Uint8Array;
}>;

/** Whether one of `events` is exactly this withdrawal's burn: from the sender, to the recipient, for the amount, with the fee and the hook. */
export function burnMatches(
  events: readonly DepositForBurnEvent[],
  expected: ExpectedBurn,
): boolean {
  const sender = normalizeSuiAddress(expected.sender);
  const recipient = normalizeSuiAddress(expected.mintRecipient);
  const hook = `0x${toHex(expected.hookData)}`;
  return events.some(
    (event) =>
      event.depositor === sender &&
      event.mintRecipient === recipient &&
      event.amount === expected.amount &&
      event.destinationDomain === destinationDomain(expected.destination) &&
      event.destinationCaller === ZERO_ADDRESS &&
      event.maxFee === expected.maxFee &&
      event.minFinalityThreshold === WITHDRAW_FINALITY_THRESHOLD &&
      event.hookData === hook,
  );
}

/** `0x` + hex bytes as bytes (the stored hook). */
export function hookBytes(hex: string): Uint8Array {
  return fromHex(hex.slice(2));
}

/** A shared object's id, normalized (for comparisons). */
export function sharedObjectId(object: PresaleSharedObject): string {
  return normalizeSuiObjectId(object.objectId);
}
