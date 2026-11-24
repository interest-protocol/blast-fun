# Launchpad identity and protected writes

`packages/server/src/modules/launchpad-identity/` is the one boundary every launchpad
off-chain write (social posts, post-launch metadata) goes through. A write
needs no Blast Account: it accepts either a verified Privy session or a free
Wallet Proof, a signed personal message that is never a transaction. The
module shares code with Mission Control (the trusted-request guard, the Sui
signature verifier, the database module) but none of its records.

## Contract

| Piece | Where | Use |
| --- | --- | --- |
| `createLaunchpadMutationHandler(definition, runtime)` | `mutation.ts` | turns a write definition into a `POST` route handler |
| `LaunchpadMutationDefinition` | `mutation.ts` | `action`, exact `fields`, `parse`, `rateLimit`, optional `prepare(input, { actor })` (slow work after the credential is verified, outside the transaction, before a proof is consumed), optional `authorize`, `write`, `present`, optional `maxBodyBytes` (16 KiB default, 64 KiB at most) |
| `LaunchpadActor` | `contracts.ts` | the only attribution a write may store: `{ method: "wallet_proof", walletAddress }` or `{ method: "privy", subjectKey, walletAddress \| null }` |
| `LAUNCHPAD_PROOF_ACTIONS` | `contracts.ts` | the closed list of actions a proof can name; add yours here (no migration needed) |
| `parseHttpsUrl`, `canonicalSuiAddress`, `hasExactKeys` | `contracts.ts` | normalizers for `parse` |
| `withLaunchpadRuntime(operation)` | `runtime.ts` (server-only) | the production pool, limiter, identity and origin, or a 503 when unconfigured (see Operations) |
| `POST /api/launchpad/wallet-proofs` `{ action, address }` | `route.ts` | 201 `{ challenge: { challengeId, action, address, message, expiresAt } }` to sign |
| `GET /api/launchpad/csrf` | `route.ts` | 204; sets the `__Host-blast_csrf` double-submit cookie when missing |

A route for a new write:

```ts
import { createLaunchpadMutationHandler } from "@/modules/launchpad-identity/mutation.ts";
import { withLaunchpadRuntime } from "@/modules/launchpad-identity/runtime.ts";

export function POST(request: Request) {
  return withLaunchpadRuntime((runtime) =>
    createLaunchpadMutationHandler(definition, runtime)(request),
  );
}
```

`write` receives the transaction; the owning module writes its own tables
through `transaction.forModule(<its module>)`. `authorize` sees the actor and
a read-only view of the same transaction.

## Request

The body is exactly `{ input }` with an `Authorization: Bearer <Privy access
token>` header, or exactly `{ input, proof }` with no such header, where
`proof` is exactly `{ challengeId, address, message, signature }`. Both
credentials at once is a 400; neither is a 401. The client first gets the
CSRF cookie (`GET /api/launchpad/csrf`) and sends it back in `x-blast-csrf`.

## Order of checks

Nothing reaches a repository until every earlier step passes:

1. Method `POST` (405), `Origin` and CSRF (403, `ORIGIN_INVALID` /
   `CSRF_INVALID`), `Content-Type: application/json` (415), body size (413).
2. Strict UTF-8 JSON with exactly the fields above; `input` has exactly the
   definition's `fields` and passes its `parse` (400).
3. The definition's rate bucket from the shared registry (429 with
   `Retry-After`, 503 when the limiter is unavailable).
4. The credential. Privy: the token is verified and the user read from
   Privy (401 invalid or expired, 503 when Privy fails). Wallet Proof: the
   `launchpad_wallet_proof` bucket for the IP and address, then the stored
   challenge must be unspent and unexpired and match the write's action, the
   site origin, the address and the exact message (hash) and nonce; then the
   signature is verified. A signature that does not decode, has the wrong
   length or names an unknown scheme is invalid (401). Plain zkLogin and
   multisig proofs carrying a zkLogin partial are verified by a fullnode.
   For plain zkLogin, a fullnode that rejects the input
   (`INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `OUT_OF_RANGE`) or answers
   "not valid" makes the proof invalid (401); any other status or a network
   failure is a 503. A verification failure for any other signature,
   including a multisig carrying a zkLogin partial, returns 401.
4b. The definition's optional `prepare(input, { actor })`, outside any
   transaction, for slow work such as decoding or external storage; its result
   is the input `authorize` and `write` see. `actor` is the verified Privy
   actor, or for a Wallet Proof `{ method: "wallet_proof", walletAddress }`
   with the checked (not yet consumed) proof's address, so `prepare` can refuse
   a request that is not the writer's before any slow work. A `LaunchpadMutationError` it throws answers
   with that error's code and status (for example 400
   `LAUNCHPAD_REQUEST_INVALID` or 503 `LAUNCHPAD_UNAVAILABLE`); any other
   throw is a 500 (`LAUNCHPAD_INTERNAL_ERROR`). Either way no transaction
   opens and no Wallet Proof is spent, but the rate budgets of steps 3 and 4
   are already spent. `prepare` runs **before** `authorize`, so it must not
   depend on the actor being allowed to write; it runs once for **every**
   concurrent use of the same proof, although only one of them can commit;
   and nothing rolls it back. It must therefore be idempotent and safe to
   leave behind (for example content-addressed storage, as launch images do).
5. One transaction: the proof is consumed with a conditional `UPDATE`, the
   definition's `authorize` runs (403), then its `write`, which may refuse
   with 404 `LAUNCHPAD_NOT_FOUND` (its target does not exist, such as a
   launch that is not canonical) or 409 `LAUNCHPAD_CONFLICT` (its target
   changed, such as a record already revised). Any refusal or
   failure rolls everything back, so a proof is spent only by the write it
   authorized, and of concurrent uses exactly one commits.

## Wallet Proof

A challenge binds the action, the site origin, the canonical Sui address, a
32-byte random nonce, the issue time and a five-minute expiry. The message
says it is not a transaction and costs nothing. Only SHA-256 hashes of the
nonce and message are stored, in `mission_control_launchpad_wallet_challenges`
(owned by the `launchpad-identity` module, granted to `blast_web` only,
migration `0032_launchpad_identity`). The maintenance cleanup deletes a
challenge an hour after it expires, spent or not.

## Rate limits

The launchpad has its own registry entries (`lib/web-security/rate-limits.ts`),
counted apart from Mission Control's `wallet` bucket:

| Bucket | Counts | Keyed by | Policy |
| --- | --- | --- | --- |
| `launchpad_wallet_proof_issue` | challenge issuance | client IP alone, so rotating addresses shares one budget | 5 per 10 minutes |
| `launchpad_wallet_proof` | every proof check of a proof-backed write | client IP, address and operation (like `wallet`) | 5 per 10 minutes |
| `launchpad_launch_asset` | every launch image upload, either credential | client IP | 5 per 10 minutes |
| `launchpad_social_post` | every social post write, either credential ([social](social.md)) | client IP | 5 per 10 minutes |
| the write's own `rateLimit.bucket` | every request to that write, either credential | the write's `subject` | the write's entry |

**Provisional.** Both proof buckets, the launch image bucket and the social
post bucket reuse the `wallet` policy values; no new numbers were chosen.
Setting the final public limits is an owner release gate before any launchpad
write route goes public, together with the provisional social content limits
(`SOCIAL_LIMITS`, [social](social.md#limits-provisional)).

## Privy

`createPrivySessionVerifier` (`lib/privy-adapter`) accepts any Privy login
method and returns only the DID and the user's embedded Sui wallet address.
The launchpad turns the DID into `subjectKey`, an HMAC-SHA256 keyed with
`LAUNCHPAD_SUBJECT_PEPPER` (32+ characters); the DID itself never leaves the
identity service. Changing the pepper changes every Privy actor's key.

## What never leaves the server

Error bodies are fixed codes and messages; they never echo input. Metrics
carry these fields only:

| Metric | Fields |
| --- | --- |
| `launchpad.mutation` | `action`, `credential` (`privy` or `wallet_proof`, absent before one is read), `outcome` (`ok`, `refused`, `error`), `status`, and on failure `code`: the public error code, or for an unexpected 500 the error's SQLSTATE or class name (`errorLabel`) |
| `launchpad.wallet_proof.issue` | `action` and `outcome: "ok"`; on failure `code`, `outcome` and `status` |
| `launchpad.identity` | a provider or verifier outage: `outcome: "error"`, `step` (`privy` or `signature`) and `error` (`errorLabel`); a runtime that cannot start: `outcome: "config_unavailable"` and `reason` |
| `db.transaction` | `label: "launchpad.<action>"` with the database module's usual fields |

No
response, log, metric or row holds an access token, signature, raw challenge
or nonce, or Privy DID. The challenge message goes only to the requester, with
`Cache-Control: no-store`.

## Operations

Without `RATE_LIMIT_SUBJECT_PEPPER` or `LAUNCHPAD_SUBJECT_PEPPER` (each 32+
characters) every launchpad write and challenge answers 503
`LAUNCHPAD_UNAVAILABLE`. Each such request records `launchpad.identity` with
`outcome: "config_unavailable"` and `reason` `rate_limit_pepper_missing` or
`subject_pepper_missing` (`setup_failed:<errorLabel>` for any other setup
failure) and logs one JSON warning with the same reason. Neither carries a
setting's value. Alert on any `config_unavailable`.

```bash
npm run test:integration -w @blast/server -- src/modules/launchpad-identity/launchpad-identity.integration.test.ts
```
