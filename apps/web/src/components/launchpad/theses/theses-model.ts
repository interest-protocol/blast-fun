// The Theses destination's state and wording, browser-safe and pure. A post
// is its author's claim; Blast states only the facts it checked (the creator
// relation and a disclosed wallet's holding), with the time it was observed, and never endorses, scores or summarizes a post.

import { shortAddress } from "@blast/core/lib/format.ts";
import { parseEvidenceLinks, parseInertText, UNSAFE_TEXT, type PostInput, type PostKind, type ThesisStance } from "@blast/core/modules/launchpad-social/post-contract.ts";
import { SOCIAL_LIMITS } from "@blast/core/modules/launchpad-social/limits.ts";
import type { ThesisListPage } from "@blast/core/modules/launchpad-social/list-contract.ts";
import type { PublicPost } from "@blast/core/modules/launchpad-social/post-contract.ts";
import { mapSectionState, refreshFailed, type SectionState } from "../primitives/data-state.ts";
import type { ThesesAnswer } from "./theses-client.ts";

export type ThesesState = Readonly<{
  section: SectionState<ThesisListPage>;
  loadingMore: boolean;
  /** Why the last "more" page failed; the loaded posts stay. */
  moreError: string | null;
}>;

export const INITIAL_THESES: ThesesState = { section: { status: "loading" }, loadingMore: false, moreError: null };

const REASONS: Readonly<Record<string, string>> = {
  "replica-lag": "the read replica is behind",
  "indexer-lag": "the indexer is behind the chain",
  "replica-unavailable": "the read replica did not answer",
  "primary-unavailable": "the primary database did not answer",
  "social-unavailable": "the primary database did not answer",
  "no-checkpoint": "the indexer has not committed a checkpoint yet",
  "network-mismatch": "the database indexes another network",
  "deployment-mismatch": "the database indexes another deployment",
  unconfigured: "thesis are not configured here",
  "contract-violation": "the answer did not pass validation",
};

export function describeThesesReason(reason: string): string {
  return REASONS[reason] ?? `the source answered ${reason}`;
}

const FAILED = "the request did not complete";

/** The first page's answer: a failure keeps verified posts Stale, never empty. */
export function afterRead(state: ThesesState, answer: ThesesAnswer): ThesesState {
  if (answer === null || answer === "invalid") return { ...state, section: refreshFailed(state.section, FAILED) };
  const next = mapSectionState(answer.theses, describeThesesReason);
  const section = next.status === "unavailable" ? refreshFailed(state.section, next.reason) : next;
  return { section, loadingMore: false, moreError: null };
}

/** The next page's answer, appended after the loaded posts (the token resumes strictly after them). */
export function afterMore(state: ThesesState, answer: ThesesAnswer): ThesesState {
  const { section } = state;
  if (section.status !== "ready" && section.status !== "stale") return { ...state, loadingMore: false };
  const page = answer !== null && answer !== "invalid" && (answer.theses.state === "available" || answer.theses.state === "stale" || answer.theses.state === "empty")
    ? answer.theses
    : null;
  if (page === null) {
    return { ...state, loadingMore: false, moreError: "More posts couldn’t load. Try again." };
  }
  const next = page.state === "empty" ? { items: [], nextCursor: null } : page.data;
  return {
    section: { ...section, value: { items: [...section.value.items, ...next.items], nextCursor: next.nextCursor } },
    loadingMore: false,
    moreError: null,
  };
}

/**
 * Which post takes focus after Show more: the first new one; with none, the
 * last one only when focus was lost (the button went away with the last
 * page). Null leaves focus where the reader put it.
 */
export function moreFocusIndex(before: number, after: number, focusLost: boolean): number | null {
  if (after > before) return before;
  return focusLost && after > 0 ? after - 1 : null;
}

export const KIND_LABELS: Readonly<Record<PostKind, string>> = {
  creator_thesis: "Creator thesis",
  creator_update: "Creator update",
  community_thesis: "Community thesis",
};

export const STANCE_LABELS: Readonly<Record<ThesisStance, string>> = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" };

/** Who claims the post: always its author, never Blast. */
export function postAttribution(post: Pick<PublicPost, "kind">): string {
  const author = post.kind === "community_thesis" ? "the author's" : "the creator's";
  return `${KIND_LABELS[post.kind]}: ${author} own claim. Blast does not review or endorse it.`;
}

export type PostFact = Readonly<{ term: string; detail: string; full?: string; checkedAt?: string }>;

/** Checked facts about the author and when they were observed, followed by the author’s disclosure. */
export function postFacts(post: PublicPost, symbol: string | null): PostFact[] {
  const facts: PostFact[] = [];
  const coin = symbol ?? "this coin";
  if (post.authorLabels.includes("creator")) {
    facts.push({
      term: "Creator",
      // Checked in the write's own transaction: observed when this record was written.
      detail: "Posted from the launch creator’s wallet. Checked",
      checkedAt: post.createdAt,
    });
  }
  const { disclosure } = post;
  if (disclosure.walletAddress !== null) {
    facts.push({ term: "Disclosed wallet", detail: shortAddress(disclosure.walletAddress), full: disclosure.walletAddress });
  }
  if (disclosure.observedCheckpoint !== null && disclosure.observedAt !== null) {
    facts.push({
      term: "Holding",
      detail: disclosure.verification === "verified_holder"
        ? `Held ${coin} when checked on`
        : `This wallet did not hold ${coin} when checked on`,
      checkedAt: disclosure.observedAt,
    });
  } else if (disclosure.verification === "unavailable") {
    facts.push({ term: "Holding", detail: "Blast couldn’t check this wallet’s balance when the post was published." });
  }
  if (disclosure.text !== null) facts.push({ term: "Author's disclosure", detail: disclosure.text });
  return facts;
}

const LINK_TEXT = 60;

/** An evidence link as shown: only https without credentials, labeled by host and path; null otherwise. */
export function evidenceLink(link: string): Readonly<{ href: string; host: string; text: string }> | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  const whole = `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  const text = whole.length > LINK_TEXT ? `${whole.slice(0, LINK_TEXT - 1)}…` : whole;
  return { href: url.href, host: url.host, text };
}

/** What posting needs on a page (the deployment's network, Privy, the CSP nonce), or why it is unavailable there. */
export type ThesesPosting =
  | Readonly<{ network: string; privyAppId: string | null; nonce: string }>
  | Readonly<{ unavailable: string }>;

/** What the composer last reported: a post stored, or why nothing was posted. */
export type ComposerResult = Readonly<{ tone: "ok" | "problem"; message: string }>;

/** What the composer holds; links are whitespace-separated. */
export type ComposerDraft = Readonly<{
  kind: PostKind;
  stance: ThesisStance | null;
  body: string;
  links: string;
  disclosureText: string;
  discloseWallet: boolean;
}>;

export const EMPTY_DRAFT: ComposerDraft = {
  kind: "community_thesis",
  stance: null,
  body: "",
  links: "",
  disclosureText: "",
  discloseWallet: false,
};

function textProblem(text: string, maximum: number, empty: string, control: string): string | null {
  try {
    parseInertText(text, maximum);
    return null;
  } catch {
    return UNSAFE_TEXT.test(text) ? control : empty;
  }
}

/**
 * The draft as the write's exact input, with the posting wallet disclosed
 * when asked; or what to fix, checked by the write's own parsers and limits
 * before anything is sent. The server checks it all again.
 */
export function draftInput(
  draft: ComposerDraft,
  launchId: string,
  walletAddress: string | null,
): Readonly<{ input: PostInput; problems?: undefined } | { input?: undefined; problems: string[] }> {
  const limits = SOCIAL_LIMITS;
  const problems: string[] = [];
  const bodyProblem = textProblem(
    draft.body,
    limits.bodyCodePoints,
    `Write the thesis: 1 to ${limits.bodyCodePoints.toLocaleString("en-US")} characters.`,
    "The thesis holds a control or direction-override character; remove it.",
  );
  if (bodyProblem) problems.push(bodyProblem);
  if (draft.stance === null && draft.kind !== "creator_update") problems.push("Choose a stance: Bullish, Bearish or Neutral.");
  let evidenceLinks: string[] = [];
  try {
    evidenceLinks = parseEvidenceLinks(draft.links.split(/\s+/).filter(Boolean), limits);
  } catch {
    problems.push(`Evidence links must be https links without a password, at most ${limits.evidenceLinks}.`);
  }
  const disclosureText = draft.disclosureText.trim() === "" ? null : draft.disclosureText;
  if (disclosureText !== null) {
    const problem = textProblem(
      disclosureText,
      limits.disclosureCodePoints,
      `Keep the disclosure to ${limits.disclosureCodePoints} characters.`,
      "The disclosure holds a control or direction-override character; remove it.",
    );
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) return { problems };
  return {
    input: {
      launchId,
      kind: draft.kind,
      stance: draft.stance,
      body: parseInertText(draft.body, limits.bodyCodePoints),
      evidenceLinks,
      disclosure: {
        text: disclosureText === null ? null : parseInertText(disclosureText, limits.disclosureCodePoints),
        walletAddress: draft.discloseWallet ? walletAddress : null,
      },
      revisionOf: null,
    },
  };
}

/** What was stored, in the author's terms: the kind kept (a creator kind needs the creator's wallet) and the holding observed. */
export function publishedNote(requested: PostKind, post: PublicPost): string {
  const kind = KIND_LABELS[post.kind].toLowerCase();
  const downgraded = requested !== "community_thesis" && post.kind === "community_thesis"
    ? ". Creator posts require the launch creator’s wallet"
    : "";
  const { disclosure } = post;
  let holding = "";
  if (disclosure.observedAt !== null) {
    holding = disclosure.verification === "verified_holder"
      ? " The wallet held the coin when checked."
      : " No balance found for this wallet.";
  } else if (disclosure.verification === "unavailable") {
    holding = " Blast couldn’t check this wallet’s balance.";
  }
  return `Posted as a ${kind}${downgraded}.${holding}`;
}
