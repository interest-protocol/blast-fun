import type { CreateIssue, CreateSection } from "@blast/core/web/contracts/create.ts";

/**
 * Create's four steps (the CreateToken, CreateRaise, Create and CreateReview
 * boards): Token, Raise, Details, Review. One draft runs through all
 * of them; a step only decides which of its parts are on screen.
 */
export const CREATE_STEPS = ["token", "raise", "details", "review"] as const;
export type CreateStep = (typeof CREATE_STEPS)[number];

export const STEP_LABEL: Readonly<Record<CreateStep, string>> = {
  token: "Coin",
  raise: "Raise",
  details: "Details",
  review: "Review",
};

/** Where each checked section is edited: the links with the cover, the sale's terms on Raise. */
const SECTION_STEP: Readonly<Record<CreateSection, CreateStep>> = {
  token: "token",
  links: "details",
  raise: "raise",
  join: "raise",
  launch: "raise",
  split: "raise",
  rsplit: "raise",
  fees: "raise",
};

/** The step a field is on: the description sits with the cover, every other field with its section. */
export function stepOf(section: CreateSection, path?: string): CreateStep {
  return path === "tagline" ? "details" : SECTION_STEP[section];
}

/** The step an issue sends the creator to. */
export const issueStep = (issue: Pick<CreateIssue, "section" | "path">): CreateStep => stepOf(issue.section, issue.path);

export const stepHash = (step: CreateStep): string => `#${step}`;

/**
 * What a URL hash names: a step (`#raise`), or a part of one (`#cr-join`,
 * the links the page had before it had steps) with the step it is on. Null
 * for any other hash.
 */
export function readStepHash(hash: string): Readonly<{ step: CreateStep; section: string | null }> | null {
  const name = hash.replace(/^#/, "");
  if ((CREATE_STEPS as readonly string[]).includes(name)) return { step: name as CreateStep, section: null };
  if (!name.startsWith("cr-")) return null;
  const part = name.slice(3);
  if (Object.hasOwn(SECTION_STEP, part)) return { step: SECTION_STEP[part as CreateSection], section: part };
  if (part === "details" || part === "review") return { step: part, section: part };
  return null;
}

/**
 * A step the step bar checks: one before the current step that has no open
 * issue. Passing a step is not finishing it, so an earlier step with an issue
 * shows no check. The Create and Launch bars share this rule.
 */
export const stepDone = <Step extends string>(steps: readonly Step[], step: Step, current: Step, open: (step: Step) => boolean): boolean =>
  steps.indexOf(step) < steps.indexOf(current) && !open(step);
