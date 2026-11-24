/**
 * The launchpad social limits: application configuration, PROVISIONAL.
 *
 * The spec sets none of these values (it asks for bounded text, query length
 * and result counts, and "configured" page limits). These are the
 * coordinator-accepted defaults for T-028 and an owner release gate, like the
 * `launchpad_social_post` rate values. Changing one needs a deploy, never a
 * migration: the database CHECKs in `0036_launchpad_social` are generous
 * safety ceilings (`DATABASE_CEILINGS`), at least ten times each limit, not
 * product limits.
 */
export type SocialLimits = Readonly<{
  /** Thesis body, in Unicode code points. */
  bodyCodePoints: number;
  /** Disclosure text, in Unicode code points. */
  disclosureCodePoints: number;
  /** Evidence links per post, and each link's length in characters. */
  evidenceLinks: number;
  evidenceLinkLength: number;
  /** Search query length in characters, words used, and each word's code points. */
  searchQueryLength: number;
  searchWords: number;
  searchWordCodePoints: number;
  /** The normalized search text kept per post, in code points (NFKC can expand text up to 18×). */
  searchTextCodePoints: number;
  searchPage: Readonly<{ default: number; max: number }>;
  thesisPage: Readonly<{ default: number; max: number }>;
  /** Holder proof: snapshot pages read at most, and one deadline for the whole proof. */
  holderProofPages: number;
  holderProofDeadlineMs: number;
}>;

export const SOCIAL_LIMITS: SocialLimits = Object.freeze({
  bodyCodePoints: 1_000,
  disclosureCodePoints: 280,
  evidenceLinks: 3,
  evidenceLinkLength: 2_048,
  searchQueryLength: 200,
  searchWords: 8,
  searchWordCodePoints: 64,
  searchTextCodePoints: 4_000,
  searchPage: Object.freeze({ default: 10, max: 25 }),
  thesisPage: Object.freeze({ default: 20, max: 50 }),
  holderProofPages: 10,
  holderProofDeadlineMs: 2_500,
});

/** The database's safety ceilings (migration 0036); every limit above stays well below them. */
export const DATABASE_CEILINGS = Object.freeze({
  bodyCharacters: 10_000,
  disclosureCharacters: 10_000,
  evidenceLinks: 32,
  /** All of a post's links together. */
  evidenceCharacters: 65_536,
  searchTextCharacters: 40_000,
});
