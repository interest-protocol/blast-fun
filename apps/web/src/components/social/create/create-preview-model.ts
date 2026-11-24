import type { CreateIssue, CreateSection } from "@blast/core/web/contracts/create.ts";

/** The checklist follows every section checked by draftIssues. */
const CHECKLIST: readonly (readonly [CreateSection, string])[] = [
  ["token", "Coin"],
  ["links", "Links"],
  ["raise", "Raise"],
  ["join", "Who can join"],
  ["split", "Token split"],
  ["rsplit", "Raise split"],
  ["launch", "Launch"],
  ["fees", "Trading fees"],
];

/**
 * The checklist's rows (R3-25): each section with its open items, each to-do
 * once (TS-2): an item two sections share ("Add Team’s Sui address" in the
 * token and raise splits) stays in the first section that needs it.
 */
export function checklistOf(issues: readonly CreateIssue[]): readonly Readonly<{ section: CreateSection; label: string; open: readonly CreateIssue[] }>[] {
  const first = new Map<string, CreateIssue>();
  for (const [section] of CHECKLIST) for (const issue of issues) if (issue.section === section && !first.has(issue.message)) first.set(issue.message, issue);
  const listed = new Set(first.values());
  return CHECKLIST.map(([section, label]) => ({ section, label, open: issues.filter((issue) => issue.section === section && listed.has(issue)) }));
}
