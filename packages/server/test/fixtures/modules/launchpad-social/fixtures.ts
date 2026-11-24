import type { SearchPage, ThesisPage } from "@blast/server/modules/launchpad-social/reads.ts";
import type { PublicPost } from "@blast/core/modules/launchpad-social/post-contract.ts";

/**
 * Typed fixtures of the public social reads for the Theses and grouped Search
 * surfaces: two canonical launches, a creator thesis and update, duplicate
 * community text, a revised post (it keeps its first-post time), and every
 * verification a public record can show. Authors are opaque identities; a
 * wallet appears only where the author disclosed it. Hidden records never
 * appear in a public read, so none is here. Shapes follow `listLaunchTheses`
 * and `searchTheses`.
 */

export const FIXTURE_LAUNCH_ALPHA = `0x${"a1".padStart(64, "0")}`;
export const FIXTURE_LAUNCH_BETA = `0x${"b1".padStart(64, "0")}`;

const PROVENANCE = {
  network: "mainnet",
  deployment: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
  checkpoint: 326_274_009,
} as const;

const NOT_DISCLOSED = {
  text: null,
  walletAddress: null,
  verification: "not_requested",
  observedCheckpoint: null,
  observedAt: null,
} as const;

const alphaCreatorUpdate: PublicPost = {
  id: "00000000-0000-4000-8000-000000000005",
  thesisId: "00000000-0000-4000-8000-000000000005",
  revisionOf: null,
  launchId: FIXTURE_LAUNCH_ALPHA,
  kind: "creator_update",
  stance: null,
  authorIdentityId: "00000000-0000-4000-8000-0000000000a1",
  body: "Liquidity plan published; migration target unchanged.",
  evidenceLinks: ["https://example.com/alpha-plan"],
  disclosure: {
    text: "Creator wallet, holding the launch allocation.",
    walletAddress: `0x${"42".repeat(32)}`,
    verification: "verified_holder",
    observedCheckpoint: "326274005",
    observedAt: "2026-10-01T12:44:59.000Z",
  },
  authorLabels: ["creator", "wallet"],
  moderationState: "public",
  provenance: PROVENANCE,
  postedAt: "2026-10-01T12:45:00.000Z",
  createdAt: "2026-10-01T12:45:00.000Z",
};

const alphaRevised: PublicPost = {
  id: "00000000-0000-4000-8000-000000000004",
  thesisId: "00000000-0000-4000-8000-000000000001",
  revisionOf: "00000000-0000-4000-8000-000000000001",
  launchId: FIXTURE_LAUNCH_ALPHA,
  kind: "community_thesis",
  stance: "bullish",
  authorIdentityId: "00000000-0000-4000-8000-0000000000b2",
  body: "Graduation looks near for Alpha.\nThe creator answered every question.",
  evidenceLinks: ["https://example.com/alpha-thread"],
  disclosure: {
    text: "Small holder.",
    walletAddress: `0x${"a3".repeat(32)}`,
    verification: "not_holder",
    observedCheckpoint: "326274001",
    observedAt: "2026-10-01T12:29:58.000Z",
  },
  authorLabels: ["wallet"],
  moderationState: "public",
  provenance: PROVENANCE,
  postedAt: "2026-10-01T12:00:00.000Z",
  createdAt: "2026-10-01T12:30:00.000Z",
};

const alphaDuplicate: PublicPost = {
  id: "00000000-0000-4000-8000-000000000002",
  thesisId: "00000000-0000-4000-8000-000000000002",
  revisionOf: null,
  launchId: FIXTURE_LAUNCH_ALPHA,
  kind: "community_thesis",
  stance: "neutral",
  authorIdentityId: "00000000-0000-4000-8000-0000000000c3",
  body: "Graduation looks near for Alpha.",
  evidenceLinks: [],
  disclosure: NOT_DISCLOSED,
  authorLabels: [],
  moderationState: "public",
  provenance: PROVENANCE,
  postedAt: "2026-10-01T12:10:00.000Z",
  createdAt: "2026-10-01T12:10:00.000Z",
};

const betaBear: PublicPost = {
  id: "00000000-0000-4000-8000-000000000003",
  thesisId: "00000000-0000-4000-8000-000000000003",
  revisionOf: null,
  launchId: FIXTURE_LAUNCH_BETA,
  kind: "community_thesis",
  stance: "bearish",
  authorIdentityId: "00000000-0000-4000-8000-0000000000b2",
  body: "Beta whales are selling into every bounce.",
  evidenceLinks: ["https://example.com/beta-holders", "https://example.org/beta-chart"],
  disclosure: {
    text: "I sold.",
    walletAddress: `0x${"a3".repeat(32)}`,
    verification: "unavailable",
    observedCheckpoint: null,
    observedAt: null,
  },
  authorLabels: ["wallet"],
  moderationState: "public",
  provenance: PROVENANCE,
  postedAt: "2026-10-01T12:20:00.000Z",
  createdAt: "2026-10-01T12:20:00.000Z",
};

const ALPHA = {
  launchId: FIXTURE_LAUNCH_ALPHA,
  coinType: `0x${"a2".padStart(64, "0")}::alpha::ALPHA`,
  name: "Alpha",
  symbol: "ALPHA",
  iconUrl: "https://i/a.png",
  lifecycle: "live",
  creator: `0x${"42".repeat(32)}`,
  createdAtMs: 1_790_000_000_001,
} as const;

/** Alpha's posts, newest first post first: the revised thesis keeps its 12:00 place. */
export const FIXTURE_ALPHA_THESES: ThesisPage = {
  launchId: FIXTURE_LAUNCH_ALPHA,
  theses: [alphaCreatorUpdate, alphaDuplicate, alphaRevised],
  nextCursor: null,
};

/**
 * A search for "graduation": duplicate text, newest first post first (the
 * revised thesis keeps its 12:00 place), each with its launch's chain identity.
 */
export const FIXTURE_SEARCH_GRADUATION: SearchPage = {
  theses: [
    { thesis: alphaDuplicate, launch: ALPHA },
    { thesis: alphaRevised, launch: ALPHA },
  ],
  nextCursor: null,
};

/** A search for "beta": one launch whose Coin Registry metadata has no icon yet. */
export const FIXTURE_SEARCH_BETA: SearchPage = {
  theses: [
    {
      thesis: betaBear,
      launch: {
        launchId: FIXTURE_LAUNCH_BETA,
        coinType: `0x${"b2".padStart(64, "0")}::beta::BETA`,
        name: "Beta",
        symbol: "BETA",
        iconUrl: null,
        lifecycle: "migrated",
        creator: null,
        createdAtMs: 1_790_000_000_002,
      },
    },
  ],
  nextCursor: null,
};

/** A search with no match: an empty list, which is not an unavailable read. */
export const FIXTURE_SEARCH_EMPTY: SearchPage = { theses: [], nextCursor: null };
