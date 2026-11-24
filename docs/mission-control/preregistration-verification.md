# Preregistration verification — 24 September 2026

Historical release evidence for the retired Season Zero signup campaign.

## Implemented flow

Power on → launch code → one intent → X connection and automatic embedded
Sui wallet → review and off-chain signature → card and rewards.

Intent choices are Trade coins, Launch a coin, Grow a community and Just
looking. The internal membership categories are Recon, Foundry, Signal and
Ground. Signup no longer asks for a fleet, launch method, wallet choice or
manual callsign. Reserved or occupied callsigns receive an automatic suffix.

The final page uses one centered column. Card, crew number, role, sharing,
launch codes and optional Telegram are prominent. Account details, wallet
management and recruits are expandable. Returning crew use X and their
embedded-wallet proof without another launch code.

Signup grants zero codes. Two codes are granted once after a verified follow of
`@blastdotfun` from the connected X account. Sharing the card is optional and
prefills only its public link; no post verification is required. Members who
previously verified a follow without earning the reward can claim their two
codes without another X request. Existing reward receipts prevent duplicate
issuance. Submitting a self-reported Telegram username
grants one code once, independently of X.
Editing Telegram or repeating requests cannot increase these rewards.

### Follow-only reward rollout

Migration `0028_follow_only_reward` changes the reward constraint and immutable
allocation guard; it does not update or delete existing allocations, codes,
events, profiles, or verified states. The application continues to use the
historical `card.shared.v1` reward receipt so existing rewards cannot be issued
again. Post verification remains available to older clients but grants no codes.

Apply the migration before deploying the follow-only application. It is
transactional, with a one-second lock timeout and five-second statement timeout.
If either timeout is reached, the migration must abort and be retried later;
do not disable the guardrails to force it through live traffic.

The migration is compatible with the old flow before the new application starts
issuing follow-only rewards. After those rewards exist, use a forward fix:
rolling back the database or serving the old reward-writing application is not
safe. The down migration deliberately refuses incompatible reward rows instead
of revoking codes. Coordinate the application cutover and do not send users to
older deployments afterward.

Disposable-PostgreSQL coverage checks all seven legacy states (no checks,
follow only, post only, both, Telegram only, follow + Telegram, both + Telegram),
exact row preservation, lock-timeout rollback, unsafe downgrade refusal,
concurrent claims, already-issued rewards, and failed code-creation rollback.
No production migration has been applied by this change. The X follow API's
production 403 access issue remains separate; failed checks do not grant codes.

Code entry is limited on the server to 10 attempts per minute and 30 per
hour per IP. HTTP 429 includes the server's retry delay. The code form shows
a countdown and blocks requests until it expires, preserving the deadline
across refreshes in the same tab. Incomplete and concurrent submissions are
also blocked locally; server enforcement remains authoritative.

## Evidence

- Full unit suite: 119 passed. After the final draft cleanup, all 21 focused
  onboarding/profile-domain tests passed.
- Completion database suite: both integration tests passed against disposable
  PostgreSQL. Includes Ground membership/card persistence, idempotency,
  rollback, concurrent reward requests, both reward orders and wallet proofs.
- ESLint, TypeScript and whitespace checks passed.
- Code cooldown: 12 focused unit tests passed. Browser verification with a
  mocked 429 response confirmed incomplete/duplicate request blocking,
  cooldown persistence after refresh and successful retry after expiry.
  No uncaught errors or horizontal overflow at the five widths listed below.
- Vercel production build passed; preview deployment is READY.
- React Doctor: latest scan 79/100 over 68 changed files (previous scan
  81/100 over 63 files); the same single onboarding component-complexity
  warning remains, with no diagnostics on the cooldown changes.
- Browser tests with mocked provider/API responses passed signup, automatic
  wallet setup, immediate owner-page display, failed owner fetch/retry,
  Telegram validation/save failure/retry/edit, wrong-X-account rejection,
  verified follow and share, download, logout and code-free restore. One completion
  request, no page reload and no uncaught page errors. No horizontal overflow
  at widths 320, 407, 768, 1054 and 1414; reduced motion and keyboard activation
  were exercised.
- Real hosted preview: admission GET 200, admission POST 201, telemetry 200,
  new intent/connect screens visible, no uncaught page errors.
- Real Privy OAuth initialization returned 200. X's authorization endpoint
  returned 403 in the automated browser. This does not establish whether a
  normal user's browser can finish authorization.
- Follow-up diagnosis: the exact same generated OAuth URL returned HTTP 200
  with the title `Authorize app / X` through a direct HTTP client. The
  automated browser also returned 403 from the bare X authorization endpoint,
  without BLAST OAuth parameters. The generated callback points to Privy's
  `/api/v1/oauth/callback` and includes a client ID and PKCE challenge. Evidence
  points to a browser/network restriction affecting this test environment;
  it does not establish a BLAST login regression. The removed raw X/Google
  OAuth variables are not read by the active Privy login path.

## Deployment and configuration

Canonical preview: https://blast-v2-git-develop-interest-protocol.vercel.app

Deployment: https://blast-v2-620j4r3rk-interest-protocol.vercel.app

Use the canonical preview for signup: mutation-origin checks and OAuth use
that configured origin. The preview-only master code (`0000-0000`) was
removed on 2026-09-25; the team tests through the password-protected `/team`
route instead.

Migrations through `0018_ground_crew_intent` are applied to the configured
database. No records were reset during this update. The X read token is now
configured as a secret for the develop preview. Six unused raw OAuth/signing
variables were removed from that preview; local unused-variable cleanup was
already completed.

## Remaining live launch checks

1. On the canonical preview, complete a real X login, embedded-wallet creation,
   signature and card claim. Follow `@blastdotfun` and verify the follow;
   confirm exactly two codes without publishing or verifying a post. Add
   Telegram; confirm one extra code. Log out and restore.
2. Configure production's runtime environment and canonical site origin before
   publishing. At inspection, production had no Mission Control database,
   Privy, code-encryption/session or X-read configuration. Do not override
   Vercel's environment/branch variables.
3. Deploy to production and verify the real production OAuth callback and
   publicly accessible card/image previews. Production was not deployed by
   this task.

The automated browser tests simulate external identities and reward
verification. They do not substitute for a real Privy/X signup or a real
follow verification. No social post was published during testing.
