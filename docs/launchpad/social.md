# Launchpad social records

`apps/web/src/modules/launchpad-social/` keeps the launchpad's coin-scoped social
records (spec §6.9): one author's **post** on one launch, a community or
creator thesis or a creator update, with its moderation and its search
materialization. There is no global feed or chat: every record names exactly
one launch. Social tables never hold a chain fact (no price, lifecycle,
balance or coin metadata); they hold the launch ID and join blast-infra's
`chain_read_v1` views for anything about the launch.

## Canonical launches

A launch is canonical while `chain_read_v1.pools` lists its curve
(`pool_key = 'blast_curve:<launch_id>'`, venue `blast_curve`) with its coin in
`chain_read_v1.coins`. A write checks it inside its transaction; every public
read joins it. A launch blast-infra does not list, a pool of another venue
and a launch it no longer lists (a replay) therefore have no posts and no
search hits, while their records stay for audit. Social rows never create a
launch.

## Contract

| Piece | Where | Use |
| --- | --- | --- |
| `POST /api/launchpad/theses` | `apps/web/src/app/api/launchpad/theses/route.ts` | the write: `postHandler(postMutationDependencies(), launchpadRuntime)` |
| `GET /api/launchpad/theses?launchId=&cursor=&limit=` | same route, `list-resource.ts` | one page of a launch's public posts (below) |
| `postMutation(dependencies)`, `postHandler(dependencies, runtime)` | `mutation.ts` | the protected `social_post` write (T-005 mutation guard) |
| `postMutationDependencies()` | `runtime.ts` (server-only) | production wiring: limits, expected deployment, holder proof over blast-infra |
| `listLaunchTheses(launchId, { limit, cursor })` | `reads.ts` | a launch's public posts: posts from the primary, the launch's identity through `readChainJoin("thesis-join")` |
| `searchTheses(query, { limit, cursor })` | `reads.ts` | public post search: posts and search rows from the primary, each hit's launch identity through `readChainJoin("search")`, a page at a time (grouped search, [search](search.md), serves it) |
| `handleThesisListRequest(request, source)`, `databaseThesisSource()` | `list-resource.ts` | the list route's handler and its database source |
| `parseThesisListResponse(body, launchId)`, `parsePublicPost(post, launchId)` | `list-contract.ts` (browser-safe) | the strict browser parsers of the list and of a published post |
| `setThesisVisibility(pool, { recordId, visibility, reason, moderator })` | `moderation.ts` | hide or restore one record (`moderation` workload, primary) |
| `parseModerationCommand(args)`, `runModerationCommand(command, operator, ports)` | `moderation-command.ts` | the operator command `npm run launchpad:moderate -w @blast/web` (below) |
| `postAudit(database, thesisId)` | `reads.ts` | every version, the author's identity and every moderation action; never a public response |
| `snapshotHolderProof(...)`, `HolderProofPort` | `holder-proof.ts` | the optional checkpointed holder verification |
| `SOCIAL_LIMITS` | `limits.ts` | the provisional limits (below) |
| `FIXTURE_*` | `fixtures.ts` | typed public post and search pages for the Theses and Search surfaces |

## The public post

```ts
type PublicPost = {
  id: string;                // this record
  thesisId: string;          // the post across revisions (its first record's id)
  revisionOf: string | null; // the record this one replaces
  launchId: string;
  kind: "creator_thesis" | "creator_update" | "community_thesis";
  stance: "bullish" | "bearish" | "neutral" | null; // null only for a creator update
  authorIdentityId: string;  // opaque; never a Privy subject or a wallet
  body: string;
  evidenceLinks: string[];
  disclosure: {
    text: string | null;
    walletAddress: string | null; // only a wallet the author disclosed
    verification: "verified_holder" | "not_holder" | "unavailable" | "not_requested";
    observedCheckpoint: string | null; // the holder snapshot's checkpoint (decimal)
    observedAt: string | null;         // the holder snapshot's time
  };
  authorLabels: string[];    // "creator" (creator kinds), "wallet" (a disclosed wallet)
  moderationState: "public";
  provenance: { network; deployment; checkpoint }; // the launch was canonical here when written
  postedAt: string;          // first post, server time; a revision keeps it
  createdAt: string;         // this record, server time
};
```

**Authors.** `mission_control_launchpad_social_authors` keeps each author's
durable identity once: a Privy subject key (a keyed hash of the DID, never the
DID) or a wallet proven with a Wallet Proof. Posts and responses carry only
the opaque `authorIdentityId`. No wallet is published unless the author puts
it in `disclosure.walletAddress`; that includes a Privy user's embedded wallet.
Labels are projections of named identity sources: `creator` (a creator kind,
kept only when the writer's wallet was the launch's creator in
`chain_read_v1.coins` at write time) and `wallet` (a
disclosed wallet). No profile or X source exists yet.

## The post write

Input, exactly: `{ launchId, kind, stance, body, evidenceLinks, disclosure: { text, walletAddress }, revisionOf }`.

| Field | Rule |
| --- | --- |
| `launchId` | canonical object ID (`0x` + 64 lowercase hex) |
| `kind` | the requested kind. `creator_thesis` and `creator_update` are kept only when the writer's wallet (proven, or the Privy user's embedded wallet) is the launch's creator; otherwise the post is stored, and answered, as a `community_thesis` without the Creator label (AC-098). A revision keeps its post's stored kind, whatever it requests |
| `stance` | `bullish`, `bearish` or `neutral`; null only for a stored `creator_update`. A request whose stored kind is not a creator update and has no stance is 400 `LAUNCHPAD_STANCE_REQUIRED` (a community thesis needs a stance, AC-097) |
| `body` | inert text: well-formed Unicode in NFC, `\r\n` as `\n`, trimmed, no C0/C1 control but tab and newline, no bidirectional embedding, override or isolate |
| `evidenceLinks` | https links without credentials (normalized, duplicates dropped) |
| `disclosure.text` | null or inert text |
| `disclosure.walletAddress` | null, or the writer's own wallet: the proven wallet or the Privy user's embedded wallet (403 otherwise, before anything is read) |
| `revisionOf` | null, or the author's own public record of the same launch and kind that is still its post's current one |

A bad field is 400 before any credential is read. A disclosed wallet that is
not the writer's is 403 in the guard's `prepare` step, before any holder
read. In the write's transaction: no committed checkpoint in
`chain_read_v1.watermark`, or another deployment than
`BLAST_NETWORK`/`BLAST_DEPLOYMENT_FINGERPRINT`, is 503
(`LAUNCHPAD_UNAVAILABLE`); a launch that is not canonical is 404
(`LAUNCHPAD_NOT_FOUND`); a creator kind from a writer who is not the
creator becomes a community thesis, and without a stance is 400
(`LAUNCHPAD_STANCE_REQUIRED`); a revision of another author's, another
launch's, a hidden or an unknown record, or of a creator post by a writer no
longer verified as its creator, is 403; of a record that already has a
revision 409 (`LAUNCHPAD_CONFLICT`; of two concurrent revisions exactly one
commits). Every refusal rolls back the whole write and leaves a Wallet Proof
unspent.

**Holder verification.** Optional and never blocking. When a wallet is
disclosed, the guard's `prepare` step, outside the transaction, reads
blast-infra's holder snapshot (T-027) of the launch's coin page by page, all
within one deadline: `verified_holder` when the wallet appears, `not_holder`
when every page of one checkpoint was read without it, both stored with that
snapshot's checkpoint and time. An incomplete snapshot, pages of different
checkpoints, too many pages, the deadline, an outage, a refusal or a proof of
another coin is `unavailable`. No disclosed wallet is `not_requested`.

## Limits (provisional)

The spec sets no values. These are coordinator-accepted defaults, kept in
application configuration (`SOCIAL_LIMITS`, `limits.ts`), and an owner
release gate together with the rate values below. Changing one needs a
deploy, not a migration: the database CHECKs in `0036_launchpad_social` are
safety ceilings at least ten times each limit (`DATABASE_CEILINGS`).

| Limit | Default | Database ceiling |
| --- | --- | --- |
| Body | 1,000 code points | 10,000 characters |
| Disclosure text | 280 code points | 10,000 characters |
| Evidence links | 3, each at most 2,048 characters | 32, 65,536 characters together |
| Search query | 200 characters, the first 8 words, each cut to 64 code points | none (not stored) |
| Search results | 10, at most 25 | none |
| Thesis page | 20, at most 50 | none |
| Materialized search text | the first 4,000 code points of the normalized body | 40,000 characters |
| Holder verification | 10 pages of 100 holders (the top 1,000), one 2.5 s deadline | none |
| Rate bucket `launchpad_social_post` | per client IP, the `wallet` values (5 per 10 minutes) | none |

NFKC can expand a character up to 18 times (U+FDFA), so the search text is
cut to its configured length after normalization; a valid body never fails a
CHECK.

**Unsearchable long words.** PostgreSQL's text search indexes no single word
longer than 2,047 bytes. Such a word is stored and shown, but never matches a
search. That is about 683 or more three-byte characters without a space or
punctuation, typical of long unspaced CJK runs (or an NFKC expansion such as
U+3300 repeated). Prefix search also matches only at word starts, so text in
scripts written without spaces matches only from the start of each run.

## Records are immutable

A revision is a new record that names the record it replaces; it keeps the
thesis ID, launch, kind, author and first-post time (the database's foreign
key refuses anything else). Only a record's `visibility` and
`visibility_changed_at` change. The web runtime may insert authors, records
and moderation actions and change visibility; no role may update anything
else or delete an author, a record or a moderation action (column grants,
`runtime-roles.integration.test.ts`). The replica role reads posts and search
rows, never authors. A Mission Control reset (`db:reset`) keeps all four
tables.

## Public reads

Both reads are hybrid: posts, their visibility and their search rows come
from the primary (the `social` workload), and each launch's canonical
identity from blast-infra's `chain_read_v1` views through `readChainJoin`
(`thesis-join` for a launch's list, `search` for search; the replica, routed
as its policy says, with that read's provenance). A hidden or revised record
therefore leaves every public read at once, however far the replica lags; a
post is shown only while the views list its launch. The primary failing is
Unavailable (`social-unavailable`).

- **Posts** of a launch: each post's current public record, newest first
  post first, then thesis ID. A revision keeps its post's place; a post whose
  current record is hidden is gone. The page token (T-003 envelope, scope
  `launch_theses:<launch_id>`, key the first-post time in microseconds,
  tie-break the thesis ID) resumes strictly after its place, so new posts,
  revisions and hidden posts never repeat or skip another post. A bad launch
  ID, another list's token, or a token whose key is past PostgreSQL's
  `bigint` or whose tie-break is not a thesis ID is a `CursorError` (400)
  before any read; the largest `bigint` key is a valid position. Limits clamp.
- **Search**: every word of the normalized query (NFKC, lower case) is a
  required prefix, in PostgreSQL's `simple` configuration; no operator reaches
  the query. Every hit matches every word, so there is no score: newest
  first post first, then thesis ID, as the launch's list (a revision keeps
  its post's place), so equal text and equal times are always in the same
  order. The page token (scope `search_theses:<hash of the query>`, key the
  first-post time in microseconds, tie-break the thesis ID) resumes
  strictly after its place; a key past `bigint` or a tie-break that is not a
  UUID is a `CursorError` before any read. Each hit carries its launch's identity from the
  views at query time: coin type and metadata, the curve's lifecycle and
  creation time, and the coin's creator (`LaunchIdentity`). A query without
  words or over its length is a `SocialQueryError` (400); another query's
  token a `CursorError` (400). Search reads matching posts from the primary
  in batches of `limit + 1`, skips those whose launch the views do not list
  (a replay), and reads at most four batches per page (`SEARCH_BATCHES`), or
  up to sixteen while the page has no hit yet (`SEARCH_FIRST_HIT_BATCHES`);
  bounds on work, not product limits. A page that skipped posts may hold fewer
  than `limit` hits, even none, and still a token, which resumes after the
  last post read. Grouped search serves such a page as available, never
  empty, and its surface offers Show more ([search](search.md#pages)).
- **The list route** `GET /api/launchpad/theses?launchId=&cursor=&limit=`
  takes exactly those keys, once each: anything else, or a launch ID that is
  not canonical in form, is 400 `LAUNCHPAD_QUERY_INVALID` before any read; a
  bad token or limit is 400 `LAUNCHPAD_CURSOR_INVALID`. It answers
  `{ launchId, theses: Section<{ items: PublicPost[], nextCursor }> }`:
  `available` or `stale` with the posts and the chain read's provenance,
  `empty`, or `unavailable` with a reason (503 with `Retry-After`;
  `unconfigured` without a read replica). It is always `private, no-store`.
  The browser parses it strictly (`parseThesisListResponse`): a post that is
  not a public, inert, https-linked record of the asked launch makes the
  section Unavailable (`contract-violation`), so nothing it carries is shown.

## Moderation

`setThesisVisibility` hides or restores one record and appends who
(`moderator`, an operator label), why (`reason`, a short code) and when to
`mission_control_launchpad_thesis_moderation`. Hiding removes the record's
search row; restoring rematerializes it when the record is still current.
The same visibility twice records nothing. A hidden record cannot be revised.
No threshold or automatic moderation exists: every change is one operator's
decision. Privy and Wallet Proof posts pass the same mutation guard, the same
`launchpad_social_post` rate bucket and the same moderation.

Operators moderate with `npm run launchpad:moderate -w @blast/web` against `DATABASE_URL`,
authenticated like the Mission Control operator procedure
(`MISSION_CONTROL_OPERATOR_ALLOWED_ID` and `MISSION_CONTROL_OPERATOR_TOKEN_SHA256`;
`BLAST_OPERATOR_ID` and `BLAST_OPERATOR_TOKEN` presented):

```bash
npm run launchpad:moderate -w @blast/web -- hide <recordId> spam      # leaves the list and search at once
npm run launchpad:moderate -w @blast/web -- restore <recordId> appeal
npm run launchpad:moderate -w @blast/web -- audit <thesisId>          # every version, author identity, action
```

The moderator recorded is `operator:<operator ID>`; the reason is a short
lowercase code. Stdout is one JSON line, the result; metric lines go to
stderr. A failure prints a fixed `OPERATOR_*` code on stderr and exits 1. The audit holds the author's durable identity
and is for operators only.

## Search materialization

`mission_control_launchpad_search_documents` holds one row per public current
record: its ID, launch ID and bounded normalized text (with a generated
`tsvector` and a GIN index). It is written in the same transaction as the
change it follows (create, revision, hide, restore). A post is created only
for a canonical launch; the row itself is not gated on the chain views, and
search joins them again at read time. So a launch that disappears from the
views stops matching without any social write, and a record restored during
such a gap matches again once the launch is back.

## Limits of this slice

- **Live creator authority.** AC-098 also grants the Creator label to an
  identity related to the launch's live creator authority (a later holder of
  the creator capability). `chain_read_v1` publishes only `coins.creator`, the
  authoritative creator recipient, which never changes after registration or
  claim, so only that wallet is verified as creator; a later capability
  holder's creator post is stored as a community thesis. Supporting it needs
  blast-infra to publish the capability holder.

- No profile records exist yet; search covers post text only. A profile
  source adds its own search rows.
- `GET /api/launchpad/search` serves the search ([search](search.md)).
- The post form has no revision: the write accepts `revisionOf`, but the
  page offers new posts only (a creator update is a new record).
- The coin page's Theses destination is described in
  [coin-page](coin-page.md#theses).
