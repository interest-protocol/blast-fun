import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURE_ALPHA_THESES, FIXTURE_LAUNCH_ALPHA } from "../../../../../../packages/server/test/fixtures/modules/launchpad-social/fixtures.ts";
import type { SignerKind } from "../transaction/action-machine.ts";
import type { SignerSource } from "../transaction/controller.ts";
import type { LaunchpadSigner } from "../transaction/signer.ts";
import { postThesis } from "./post-flow.ts";
import type { PostCredential, PublishOutcome } from "./theses-client.ts";
import { EMPTY_DRAFT, type ComposerDraft } from "./theses-model.ts";

const [, DUPLICATE, REVISED] = FIXTURE_ALPHA_THESES.theses;
const PRIVY_WALLET = `0x${"42".repeat(32)}`;
const DIRECT_WALLET = `0x${"a3".repeat(32)}`;

const DRAFT: ComposerDraft = { ...EMPTY_DRAFT, stance: "neutral", body: "Graduation looks near for Alpha.", discloseWallet: true };

function signerOf(kind: SignerKind, overrides: Partial<LaunchpadSigner> = {}): LaunchpadSigner {
  return {
    kind,
    label: kind === "privy" ? "Privy wallet" : "Slush",
    address: kind === "privy" ? PRIVY_WALLET : DIRECT_WALLET,
    chain: "sui:mainnet",
    signTransaction: async () => {
      throw new Error("a post never signs a transaction");
    },
    ...(kind === "privy" ? { accessToken: async () => "privy-token" } : { signPersonalMessage: async () => "signature" }),
    ...overrides,
  };
}

function source(connect: (kind: SignerKind) => Promise<LaunchpadSigner>): SignerSource & { asked: SignerKind[] } {
  const asked: SignerKind[] = [];
  return {
    asked,
    kinds: ["privy", "wallet"],
    current: () => null,
    connect: (kind) => {
      asked.push(kind);
      return connect(kind);
    },
  };
}

function publisher(outcome: PublishOutcome) {
  const sent: Array<{ input: unknown; credential: PostCredential }> = [];
  return {
    sent,
    publish: async (request: { input: unknown; credential: PostCredential }) => {
      sent.push(request);
      return outcome;
    },
  };
}

test("a Privy author posts with the session token, disclosing the embedded wallet only when asked", async () => {
  const signers = source(async (kind) => signerOf(kind));
  const { sent, publish } = publisher({ status: "published", post: DUPLICATE });
  const attempt = await postThesis({ draft: DRAFT, launchId: FIXTURE_LAUNCH_ALPHA, signer: "privy", signers, publish });
  assert.deepEqual(attempt, { problems: [], published: true, result: { tone: "ok", message: "Posted as a community thesis." } });
  assert.deepEqual(signers.asked, ["privy"]);
  assert.deepEqual(sent[0].credential, { kind: "privy", accessToken: "privy-token" });
  assert.deepEqual((sent[0].input as { disclosure: unknown }).disclosure, { text: null, walletAddress: PRIVY_WALLET });

  await postThesis({ draft: { ...DRAFT, discloseWallet: false }, launchId: FIXTURE_LAUNCH_ALPHA, signer: "privy", signers, publish });
  assert.deepEqual((sent[1].input as { disclosure: unknown }).disclosure, { text: null, walletAddress: null });
});

test("a wallet author proves the wallet it posts with, and is told when a creator kind was not kept", async () => {
  const signers = source(async (kind) => signerOf(kind));
  const { sent, publish } = publisher({ status: "published", post: REVISED });
  const attempt = await postThesis({ draft: { ...DRAFT, kind: "creator_thesis" }, launchId: FIXTURE_LAUNCH_ALPHA, signer: "wallet", signers, publish });
  assert.equal(sent[0].credential.kind, "wallet");
  assert.equal((sent[0].credential as { address: string }).address, DIRECT_WALLET);
  assert.equal(await (sent[0].credential as { signPersonalMessage(message: Uint8Array): Promise<string> }).signPersonalMessage(new Uint8Array()), "signature");
  assert.match(attempt.result?.message ?? "", /^Posted as a community thesis\. Creator posts require the launch creator’s wallet\./);
});

test("a draft with problems asks nothing of any signer; signer failures and refusals post nothing", async () => {
  const idle = source(async (kind) => signerOf(kind));
  const { sent, publish } = publisher({ status: "published", post: DUPLICATE });
  const blocked = await postThesis({ draft: { ...DRAFT, stance: null }, launchId: FIXTURE_LAUNCH_ALPHA, signer: "wallet", signers: idle, publish });
  assert.deepEqual(blocked, { problems: ["Choose a stance: Bullish, Bearish or Neutral."], published: false, result: null });
  assert.deepEqual(idle.asked, []);

  const cases: Array<[SignerSource, string, RegExp]> = [
    [source(async () => {
      throw new Error("User rejected the request");
    }), "wallet", /^Signing in was cancelled\. Nothing was posted\. Code: wallet_rejected\.$/],
    [source(async () => {
      throw new Error("No Sui wallet was found. Install Slush or another Sui wallet.");
    }), "wallet", /The sign-in could not start\. Try again\. Code: authentication_unavailable\. Nothing was posted\./],
    [source(async (kind) => signerOf(kind, { accessToken: async () => null })), "privy", /Privy returned no session.*Nothing was posted/],
    [source(async (kind) => signerOf(kind, { signPersonalMessage: undefined })), "wallet", /cannot sign a message.*Nothing was posted/],
  ];
  for (const [signers, signer, message] of cases) {
    const attempt = await postThesis({ draft: DRAFT, launchId: FIXTURE_LAUNCH_ALPHA, signer: signer as SignerKind, signers, publish });
    assert.equal(attempt.published, false);
    assert.equal(attempt.result?.tone, "problem");
    assert.match(attempt.result?.message ?? "", message);
  }
  assert.equal(sent.length, 0);

  const refused = publisher({ status: "refused", message: "This launch is not indexed by Blast right now, so it cannot take posts. Nothing was posted." });
  const attempt = await postThesis({ draft: DRAFT, launchId: FIXTURE_LAUNCH_ALPHA, signer: "privy", signers: idle, publish: refused.publish });
  assert.deepEqual(attempt.result, { tone: "problem", message: "This launch is not indexed by Blast right now, so it cannot take posts. Nothing was posted." });
});
