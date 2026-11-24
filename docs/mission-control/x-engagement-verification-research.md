# X follow verification

_Current as of 2026-09-26. Endpoint access, tiers, rate limits, and pricing can change; confirm them in both provider consoles before launch._

## Decision

Use SocialData's exact numeric-ID relationship check as the primary way to verify that the connected X account follows Blast:

`GET /twitter/user/{source_user_id}/following/{target_user_id}`

The server supplies the connected user's immutable X ID as `source_user_id` and the configured Blast account ID as `target_user_id`. It accepts a result only when SocialData returns a successful response for those exact IDs with `is_following: true`.

If SocialData is unavailable, rate limited, refuses the server credential, times out, or returns an invalid response, fall back to X's official user lookup using an OAuth user-context token authorized as Blast:

`GET /2/users/{source_user_id}?user.fields=connection_status`

Accept the result only when the returned user ID is the member's immutable ID and `connection_status` contains `followed_by`, which is the member-to-authenticated-Blast direction. This is one point lookup and never enumerates either account's follower or following collection. A successful SocialData `is_following: false` response is definitive and does not spend the official API budget.

There is no post verification. Sharing the public card remains an optional product action and never affects eligibility. One successful follow verification unlocks both launch codes, once, in the same database transaction that records the verified follow.

## User experience

Recommended copy:

> **Follow @blastdotfun on X to unlock two launch codes.**
>
> Open X, follow **@blastdotfun**, then return and click **Verify follow**.

Opening the X Follow Intent is not proof by itself. **Verify follow** asks the backend to run the provider chain. A negative result leaves the reward locked and can be retried after the user follows.

The card-sharing button may open an X compose intent with the user's public card URL, but it does not request a post URL and does not trigger a verification job.

## Configuration

- `BLAST_X_USER_ID`: immutable numeric ID of the Blast X account.
- `SOCIAL_DATA_API_KEY`: SocialData bearer credential.
- `SOCIAL_DATA_API_BASE_URL`: optional provider origin override for tests and controlled environments.
- `X_API_KEY` and `X_API_KEY_SECRET`: X app credentials used to sign the official fallback.
- `X_ACCESS_TOKEN` and `X_ACCESS_TOKEN_SECRET`: non-expiring-unless-revoked OAuth 1.0a user credentials authorized as Blast.
- `X_API_BEARER_TOKEN`: app-only token retained for the legacy post-verification endpoint, not the follow fallback.
- `X_API_BASE_URL`: optional official X origin override for load tests.

At least one follow provider credential is required. Configure both in production so the fallback exists; never use or store a member token for this flow.

## Persistence and abuse controls

- Keep the connected X user ID as the canonical identity; handles can change.
- Persist successful follow verification so the provider is not called repeatedly.
- Grant at most one two-code social reward per Blast allocation.
- Perform follow persistence and code issuance atomically and idempotently.
- Rate-limit attempts and fail closed on provider errors or malformed payloads.
- Never accept client claims, Follow Intent completion, screenshots, or handle text as proof.

SocialData documents the relationship endpoint and its current pricing at [Verify User Following](https://docs.socialdata.tools/social-actions/verify-user-following/) and [Pricing](https://docs.socialdata.tools/getting-started/pricing/). X documents `connection_status` in [Get Users by ID](https://docs.x.com/x-api/users/get-user-by-id) and the user-context signature in [Authorizing a request](https://docs.x.com/fundamentals/authentication/oauth-1-0a/authorizing-a-request). SocialData's terms assign data-use and platform-compliance responsibility to the customer, so launch approval should account for that provider risk ([SocialData terms](https://socialdata.tools/legal/terms-and-conditions)).
