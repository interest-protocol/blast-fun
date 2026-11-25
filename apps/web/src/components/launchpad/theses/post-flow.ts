import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";
import type { SignerKind } from "../transaction/action-machine.ts";
import type { SignerSource } from "../transaction/controller.ts";
import { isUserRejection } from "../transaction/signer.ts";
import { publishThesis, type PostCredential } from "./theses-client.ts";
import { draftInput, publishedNote, type ComposerDraft, type ComposerResult } from "./theses-model.ts";

export type PostAttempt = Readonly<{ problems: string[]; published: boolean; result: ComposerResult | null }>;

const NOTHING = "Nothing was posted.";

function problem(message: string, code?: string): PostAttempt {
  return { problems: [], published: false, result: { tone: "problem", message: code ? diagnosticMessage(message, { code }) : message } };
}

/**
 * One post from the composer: the draft is checked first, so a draft with
 * problems asks nothing of any signer. Then the chosen signer connects
 * (Privy signs in, a wallet connects) and the post goes out under that
 * identity: a Privy session's token, or a Wallet Proof the wallet signs. A
 * disclosed wallet is always the one that posts.
 */
export async function postThesis({
  draft,
  launchId,
  signer: kind,
  signers,
  idempotencyKey,
  publish = publishThesis,
}: Readonly<{
  draft: ComposerDraft;
  launchId: string;
  signer: SignerKind;
  signers: SignerSource;
  /** Kept for one draft, so Retry cannot post it twice. */
  idempotencyKey?: string;
  publish?: typeof publishThesis;
}>): Promise<PostAttempt> {
  const checked = draftInput(draft, launchId, null);
  if (checked.problems) return { problems: checked.problems, published: false, result: null };

  let credential: PostCredential;
  let address: string;
  try {
    const signer = await signers.connect(kind);
    address = signer.address;
    if (kind === "privy") {
      const accessToken = (await signer.accessToken?.()) ?? null;
      if (!accessToken) return problem(`Privy returned no session for this sign-in. Sign in again. ${NOTHING}`, "unauthorized");
      credential = { kind: "privy", accessToken };
    } else {
      if (!signer.signPersonalMessage) return problem(`This wallet cannot sign a message, so it cannot prove itself to Blast. ${NOTHING}`, "signer-unavailable");
      credential = { kind: "wallet", address, signPersonalMessage: signer.signPersonalMessage };
    }
  } catch (error) {
    if (isUserRejection(error)) return problem(`Signing in was cancelled. ${NOTHING}`, "wallet_rejected");
    const reason = publicErrorMessage(error, "The sign-in could not start. Try again.", "authentication_unavailable");
    return problem(`${reason} ${NOTHING}`);
  }

  const { input } = draftInput(draft, launchId, address);
  if (!input) return problem(`The post could not be prepared. ${NOTHING}`, "invalid_request");
  const outcome = await publish({ input, credential, idempotencyKey });
  if (outcome.status !== "published") return problem(outcome.message);
  return { problems: [], published: true, result: { tone: "ok", message: publishedNote(draft.kind, outcome.post) } };
}
