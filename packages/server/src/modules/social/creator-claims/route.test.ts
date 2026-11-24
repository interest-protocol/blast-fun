import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { toHex } from "@mysten/sui/utils";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import { encodeCreatorClaimMessage, type CreatorRecipient, type LaunchState } from "@interest-protocol/blast-sdk/launchpad";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import type { RateBucket, RateLimitDecision, RateLimitPort, RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { CREATOR_CAPS_PATH, CREATOR_COMMITMENT_PATH, type CreatorCapsClaim } from "@blast/core/modules/social/contracts/creator-claims.ts";
import { SOCIAL_ERRORS, type SocialErrorCode } from "@blast/core/modules/social/contracts/errors.ts";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { CreatorCapsChain, CreatorCapsSimulation } from "./chain.ts";
import { CREATOR_CLAIM_ATTESTATION_MS, createCreatorClaimRoutes, type CreatorCapsSponsorRequest } from "./route.ts";
import { creatorClaimSigner, creatorClaimSignerFromEnvironment, type CreatorClaimSigner } from "./signer.ts";

/**
 * The creator commitment and creator-caps routes without a database or node: who may claim
 * (the launch's recipient, read from the chain), the attestation the contract verifies, the
 * signer the chain must hold, the dry run, and the sponsor. The SQL is `commitment.ts`'s.
 */

const NOW = 1_791_000_000_000;
const ORIGIN = "https://blast.fun";
const APP_ID = "social-creator-claims-app";
const DID = "did:privy:creator-claims-caller";
const EMBEDDED = `0x${"e3".repeat(32)}`;
const SESSION = "s".repeat(43);
const SESSION_WALLET = `0x${"5e".repeat(32)}`;
const LAUNCH_ID = `0x${"1a".repeat(32)}`;
const MEME = `0x${"c0".repeat(32)}::meme::MEME`;
const OWN = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });

function bearer(): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: DID });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

const ACCOUNT: SocialAccount = {
  account_id: "00000000-0000-4000-8000-0000000c0001",
  kind: "new",
  callsign: "creator_pilot",
  display_name: null,
  avatar_url: null,
  x_handle: null,
  verified: false,
  onboarding: { shown: true, completed: true },
  privacy: "public",
  sharing_since_ms: null,
};

class MemoryLimiter implements RateLimitPort {
  async consume(bucket: RateBucket, subject: RateLimitSubject): Promise<RateLimitDecision> {
    void subject;
    return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
  }
}

const rows = <Row extends QueryResultRow>(list: Row[]): QueryResult<Row> => ({ rows: list, rowCount: list.length, command: "SELECT", oid: 0, fields: [] });

function launchOf(recipient: CreatorRecipient): LaunchState {
  return { objectId: LAUNCH_ID, initialSharedVersion: "41", mutable: true, memeType: MEME, quoteType: "0x2::sui::SUI", creatorRecipient: recipient } as unknown as LaunchState;
}

type Options = Readonly<{
  recipient?: CreatorRecipient;
  launch?: "absent";
  chain?: "off";
  stored?: Uint8Array | null;
  signer?: CreatorClaimSigner | null;
  chainKey?: Uint8Array;
  simulation?: CreatorCapsSimulation;
  sponsor?: (request: CreatorCapsSponsorRequest) => Promise<never>;
}>;

function harness(options: Options = {}) {
  let stored = options.stored === undefined ? OWN : options.stored;
  const signer = options.signer === undefined ? creatorClaimSigner(Ed25519Keypair.generate()) : options.signer;
  const built: Parameters<CreatorCapsChain["kind"]>[0][] = [];
  const sponsored: CreatorCapsSponsorRequest[] = [];
  const minted: unknown[][] = [];
  const query = async (text: string, values: readonly unknown[] = []) => {
    if (/^INSERT INTO social_creator_commitments/.test(text)) {
      minted.push([...values]);
      stored ??= values[1] as Buffer;
    }
    const list = /^SELECT commitment/.test(text) && stored ? [{ commitment: Buffer.from(stored) }] : [];
    return { ...rows(list), command: "COMMIT" };
  };
  const primary = { async connect() { return { on() {}, removeListener() {}, release() {}, query }; } } as unknown as Pool;
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }),
    limiter: new MemoryLimiter(),
    accounts: {
      async resolve(did) { return did === DID ? ACCOUNT : null; },
      async resolveWallet(address) { return address === SESSION_WALLET ? ACCOUNT : null; },
    },
    walletSessions: { async live(token) { return token === SESSION ? { address: SESSION_WALLET } : null; } },
    primary: () => primary,
    metricSampleRate: 0,
  });
  const chain: CreatorCapsChain = {
    async launch(launchId) {
      assert.equal(launchId, LAUNCH_ID);
      return options.launch === "absent" ? null : launchOf(options.recipient === undefined ? { kind: "account", accountCommitment: OWN } : options.recipient);
    },
    async signerPublicKeys() {
      const key = options.chainKey ?? signer?.publicKey;
      return key ? [Buffer.from(key).toString("hex")] : [];
    },
    async kind(input) { built.push(input); return new Uint8Array([1, 2, 3]); },
    async simulate() { return options.simulation ?? { status: "success" }; },
  };
  const routes = createCreatorClaimRoutes({
    kit,
    database: () => ({ async read<Row extends QueryResultRow>(text: string, values?: readonly unknown[]) { return (await query(text, values)) as unknown as QueryResult<Row>; } }),
    chain: async () => (options.chain === "off" ? null : chain),
    signer: () => signer,
    blastWallet: async (caller) => (caller.kind === "privy" ? EMBEDDED : caller.address),
    sponsor: options.sponsor ?? (async (request) => {
      sponsored.push(request);
      return { reservation_id: "r-1", transaction_bytes: "AA==", sponsor_signature: "", expires_at_ms: NOW + 110_000, gas_budget: "5000000" };
    }),
    now: () => NOW,
  });
  const auth = (as: "embedded" | "session" | "none"): Record<string, string> =>
    as === "embedded" ? { authorization: bearer() } : as === "session" ? { cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${SESSION}`, "sec-fetch-site": "same-origin" } : {};
  return {
    signer,
    built,
    sponsored,
    minted,
    commitment: (as: "embedded" | "session" | "none" = "embedded") =>
      routes.commitment(new Request(`${ORIGIN}${CREATOR_COMMITMENT_PATH}`, { headers: { origin: ORIGIN, ...auth(as) } }), testClient()),
    caps: (body: unknown, as: "embedded" | "session" | "none" = "embedded") =>
      routes.caps(new Request(`${ORIGIN}${CREATOR_CAPS_PATH}`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", ...auth(as) },
        body: JSON.stringify(body),
      }), testClient()),
  };
}

async function assertError(response: Response, code: SocialErrorCode): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, SOCIAL_ERRORS[code].status);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
}

async function claimOf(response: Response): Promise<CreatorCapsClaim> {
  const body = (await response.json()) as CreatorCapsClaim;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return body;
}

test("both routes need a signed-in account", async () => {
  const h = harness();
  await assertError(await h.commitment("none"), "unauthorized");
  await assertError(await h.caps({ launch_id: LAUNCH_ID }, "none"), "unauthorized");
});

test("the commitment is the stored one, or 32 random bytes minted once on first read", async () => {
  const kept = harness();
  assert.deepEqual(await (await kept.commitment()).json(), { account_commitment: toHex(OWN) });
  assert.equal(kept.minted.length, 0);

  const fresh = harness({ stored: null });
  const body = (await (await fresh.commitment("session")).json()) as { account_commitment: string };
  assert.match(body.account_commitment, /^[0-9a-f]{64}$/);
  assert.equal(fresh.minted.length, 1);
  assert.equal(fresh.minted[0]![0], ACCOUNT.account_id);
  assert.equal(toHex(fresh.minted[0]![1] as Buffer), body.account_commitment);
});

test("an account recipient's claim carries an attestation the contract verifies, for the Blast wallet, sponsored for an embedded wallet", async () => {
  const h = harness();
  const claim = await claimOf(await h.caps({ launch_id: LAUNCH_ID }));
  assert.deepEqual(
    { ...claim, sponsored: claim.sponsored?.reservation_id },
    {
      launch_id: LAUNCH_ID,
      meme_type: MEME,
      recipient: "account",
      claimant: EMBEDDED,
      fee: "sponsored",
      transaction_kind_bytes: "AQID",
      sponsored: "r-1",
      attestation_expires_at_ms: NOW + CREATOR_CLAIM_ATTESTATION_MS,
    },
  );
  assert.deepEqual(h.sponsored.map((r) => [r.caller, r.sender, [...r.kindBytes]]), [[{ kind: "privy", did: DID, subject: DID }, EMBEDDED, [1, 2, 3]]]);

  const [built] = h.built;
  assert.equal(built!.claimant, EMBEDDED);
  // `launch::claim_creator_caps` peels a u64 expiry, then a vector<u8> signature, and nothing else.
  const [expiry, signature] = bcs.tuple([bcs.u64(), bcs.vector(bcs.u8())]).parse(built!.attestation!);
  assert.equal(BigInt(expiry), BigInt(NOW + CREATOR_CLAIM_ATTESTATION_MS));
  assert.equal(built!.attestation!.length, 73);
  const message = encodeCreatorClaimMessage({ memeType: MEME, accountCommitment: OWN, claimant: EMBEDDED, expiryMs: BigInt(expiry) });
  assert.ok(await new Ed25519PublicKey(h.signer!.publicKey).verify(message, new Uint8Array(signature)));
  // Bound to the claimant: the same signature does not authorize another wallet.
  const foreign = encodeCreatorClaimMessage({ memeType: MEME, accountCommitment: OWN, claimant: SESSION_WALLET, expiryMs: BigInt(expiry) });
  assert.equal(await new Ed25519PublicKey(h.signer!.publicKey).verify(foreign, new Uint8Array(signature)), false);
});

test("a wallet session claims for its own address, sponsored like an embedded wallet", async () => {
  const h = harness();
  const claim = await claimOf(await h.caps({ launch_id: LAUNCH_ID }, "session"));
  assert.equal(claim.claimant, SESSION_WALLET);
  assert.equal(claim.fee, "sponsored");
  assert.equal(claim.sponsored?.reservation_id, "r-1");
  assert.deepEqual(h.sponsored.map((r) => [r.caller.kind, r.sender]), [["wallet", SESSION_WALLET]]);
});

test("an address recipient needs no attestation and is only its own wallet's to claim", async () => {
  const own = harness({ recipient: { kind: "address", address: EMBEDDED }, signer: null });
  const claim = await claimOf(await own.caps({ launch_id: LAUNCH_ID }));
  assert.equal(claim.recipient, "address");
  assert.equal(claim.attestation_expires_at_ms, null);
  assert.equal(own.built[0]!.attestation, null);

  const other = harness({ recipient: { kind: "address", address: SESSION_WALLET } });
  await assertError(await other.caps({ launch_id: LAUNCH_ID }), "not_creator_recipient");
  assert.equal(other.built.length, 0);
});

test("another account's launch, or an account with no commitment yet, signs nothing", async () => {
  for (const options of [{ recipient: { kind: "account", accountCommitment: OTHER } } as const, { stored: null }]) {
    const h = harness(options);
    await assertError(await h.caps({ launch_id: LAUNCH_ID }), "not_creator_recipient");
    assert.equal(h.built.length, 0);
    assert.equal(h.minted.length, 0, "a claim never mints a commitment");
  }
});

test("claimed or reassigned caps, an absent launch, and an invalid body are refused before any signing", async () => {
  const claimed = harness({ recipient: null });
  await assertError(await claimed.caps({ launch_id: LAUNCH_ID }), "creator_caps_claimed");
  await assertError(await harness({ launch: "absent" }).caps({ launch_id: LAUNCH_ID }), "not_found");
  for (const body of [{}, { launch_id: "0x1" }, { launch_id: LAUNCH_ID, extra: 1 }]) {
    await assertError(await harness().caps(body), "invalid_request");
  }
});

test("without a released deployment, a configured signer, or the signer the chain holds, account claims are off", async () => {
  await assertError(await harness({ chain: "off" }).caps({ launch_id: LAUNCH_ID }), "claim_unavailable");
  const unset = harness({ signer: null });
  await assertError(await unset.caps({ launch_id: LAUNCH_ID }), "claim_unavailable");
  const rotated = harness({ chainKey: new Uint8Array(32).fill(1) });
  await assertError(await rotated.caps({ launch_id: LAUNCH_ID }), "claim_unavailable");
  const revoked = harness({ chainKey: new Uint8Array() });
  await assertError(await revoked.caps({ launch_id: LAUNCH_ID }), "claim_unavailable");
  assert.equal(rotated.built.length + revoked.built.length + unset.built.length, 0);
});

test("a dry run that aborts is nothing to claim and is never sponsored; a full sponsor budget is a rate limit", async () => {
  const aborted = harness({ simulation: { status: "failure", reason: "launch:29" } });
  await assertError(await aborted.caps({ launch_id: LAUNCH_ID }), "nothing_to_claim");
  assert.equal(aborted.sponsored.length, 0);

  const limited = harness({ sponsor: async () => { throw new PresaleRouteError("budget_exceeded", { extra: { reason: "open_reservations" }, retryAfterSeconds: 30 }); } });
  await assertError(await limited.caps({ launch_id: LAUNCH_ID }), "rate_limited");
});

test("the signer reads a Sui Ed25519 private key, stays off while unset, and refuses another scheme", () => {
  const keypair = Ed25519Keypair.generate();
  const signer = creatorClaimSignerFromEnvironment({ CREATOR_CLAIM_SIGNER_KEY: keypair.getSecretKey() });
  assert.deepEqual(signer?.publicKey, keypair.getPublicKey().toRawBytes());
  assert.equal(creatorClaimSignerFromEnvironment({}), null);
  assert.equal(creatorClaimSignerFromEnvironment({ CREATOR_CLAIM_SIGNER_KEY: " " }), null);
  // This fails if a malformed key reaches the message (decodeSuiPrivateKey's own error repeats input).
  for (const key of ["not-a-key", "suiprivkey1qqqqqqqq"]) {
    assert.throws(
      () => creatorClaimSignerFromEnvironment({ CREATOR_CLAIM_SIGNER_KEY: key }),
      /^Error: CREATOR_CLAIM_SIGNER_KEY must be a Sui Ed25519 private key\.$/,
    );
  }
});
