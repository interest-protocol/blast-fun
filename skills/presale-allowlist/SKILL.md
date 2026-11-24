---
name: presale-allowlist
description: Create a Blast presale allowlist from a CSV, put its root on an allowlisted Sui presale, bind the manifest to the sale, and fetch wallets' proofs, with a Blast agent API key.
---

# Presale allowlist (agents)

Use this skill to run an allowlisted Blast presale. You upload the allowlist
and get back its Merkle `root` and `leaf_count`. The creator then makes the
sale on chain with that root. You bind the manifest to the sale, and every
listed wallet can fetch the proof it needs to commit.

The presale runs on Sui **mainnet** only. `BLAST` below is the Blast web
origin, for example `https://www.blast.fun`. Use the final host:
`https://blast.fun` redirects there, and the page cookie below is host-only.

## Authentication

Send your agent API key in the `X-Blast-Api-Key` header on the create, read
and bind calls. A Blast operator issues the key. It looks like
`blast_ak_` followed by 43 base64url characters, and it is shown once.

- With the header you may call from any origin. Nothing else is needed: no
  cookie and no `Authorization` header.
- An unknown or revoked key is `unauthorized`. A revoked key stays revoked;
  ask the operator for a new one.
- You own the manifests your key creates. Another key, or a Privy account, gets
  `not_found` for them, and the reverse is also true.
- A signed-in person can make the same calls with
  `Authorization: Bearer <Privy access token>` instead.

The proof call takes no key or account. It does need the site's page cookie;
see [step 4](#4-fetch-a-wallets-proof).

## The flow

1. **Create** the allowlist: `POST /api/presale/allowlists`. Keep `allowlist_id`, `root` and `leaf_count`.
2. **Create the sale** on chain with the SDK, passing that root and leaf count to `allowlistedEligibility`.
3. **Bind** the manifest to the sale: `POST /api/presale/allowlists/{allowlist_id}/bind`.
4. **Fetch proofs**: `GET /api/presale/presales/{presale_id}/proof?wallet=0x…`, once per committing wallet.

You can read your manifest's summary again at any time with
`GET /api/presale/allowlists/{allowlist_id}`.

### 1. Create the allowlist

`POST /api/presale/allowlists` takes a CSV upload or JSON.

**CSV:** `multipart/form-data` with these parts and no others:

- a file part `file`, holding the CSV;
- a form field `quote`, the sale's Quote coin type, such as `0xdba3…::usdc::USDC`;
- optionally, a form field `include_blast_holders`, `true` or `false` (see below).

```sh
curl -sS "$BLAST/api/presale/allowlists" \
  -H "X-Blast-Api-Key: $BLAST_API_KEY" \
  -F "file=@allowlist.csv;type=text/csv" \
  -F "quote=0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"
```

**JSON:** `Content-Type: application/json` with
`{ "quote": "<coin type>", "entries": [{ "wallet": "0x…", "cap": "<atoms>" }, …] }`
and, optionally, `"include_blast_holders": true`.

**Blast card holders (opt-in):** by default the allowlist is exactly your rows.
To add Blast's card holders, send the form field `include_blast_holders=true`
(CSV) or `"include_blast_holders": true` (JSON). Blast then appends one
verified wallet for each account with a Blast card. Those wallets get the mean
of your uploaded caps, in Quote atoms and rounded down. Your rows keep their
caps and indices, and a holder already in your rows is not added again. The
holder list changes as people get cards, so the same rows with this option can
give a different root on another day.

**CSV rules and limits:**

- The header row is exactly `wallet,cap` (case and surrounding spaces are ignored). Each data row is `wallet,cap` and nothing else.
- `wallet` is a Sui address, `0x` and 1 to 64 hex characters. A short address is left-padded to 64 characters and gets a `normalized_address` warning.
- `cap` is the wallet's commitment cap in Quote atoms. It is a base-10 integer from 1 to 18446744073709551615 (the u64 maximum).
- Each wallet appears once.
- There is at least one data row. The allowlist, including any card holders you opt in to, holds at most 65,536 distinct wallets.
- The whole upload, CSV or JSON, is at most 4 MiB.
- Row order is the leaf order: data row *n* is leaf index *n* − 1. Without card holders, the same rows in the same order always give the same root.
- Invalid rows are reported by row number (the 1-based data row, not counting the header). Up to 100 rows come back in `error.rows` as `{ row, reason }`. Fix them all and upload again. Nothing is stored from a refused upload.

The response counts and `total_cap` describe the stored list, including any
card holders. Always create the sale with the returned root and leaf count.

**201 response:**

```json
{
  "allowlist_id": "0f6e…",
  "root": "4c1e…(64 lowercase hex, no 0x)",
  "leaf_count": "3",
  "entry_count": 3,
  "total_cap": "1500000000",
  "warnings": [{ "code": "normalized_address", "message": "…", "row": 3 }]
}
```

The warnings are advisory, and the manifest is stored anyway:

- `quote_not_allowed`: the current creation policy does not allow this Quote, so a sale with it cannot be created yet.
- `normalized_address`: a short address was padded. After 100 rows, one item counts the rest.

| Error | Status | Meaning |
| --- | --- | --- |
| `invalid_allowlist` | 422 | Rows are invalid; see `error.rows`. |
| `allowlist_too_large` | 413 | Over 65,536 distinct wallets, including any card holders you opted in to, or over 4 MiB. |
| `invalid_request` | 400 | Wrong content type, a missing or extra part or field, a wrong header row, an invalid Quote type, `include_blast_holders` other than `true` or `false`, or no rows. |
| `unauthorized` | 401 | The key or token is missing, unknown or revoked. |
| `origin_invalid` | 403 | A browser `Origin` from another site, with no API key. |
| `rate_limited` | 429 | Over the `presale_allowlist` budget. Wait for `Retry-After` seconds. |
| `service_unavailable` | 503 | Temporary. Retry after `Retry-After` seconds. |

### 2. Create the sale with the manifest's root

The sale's eligibility must be the manifest's root and leaf count exactly.
Build it with the SDK (`@interest-protocol/blast-sdk/presale`) from the create
response:

```ts
import { allowlistedEligibility, PresaleTransactions } from "@interest-protocol/blast-sdk/presale";

const { root, leaf_count } = createResponse; // root: 64 lowercase hex, no 0x
const eligibility = allowlistedEligibility(root, BigInt(leaf_count));
const tx = new PresaleTransactions(deployment).createBluefinPresale({ ...terms, eligibility /* … */ });
```

`allowlistedEligibility(root, BigInt(leaf_count))` is the only correct
eligibility for this allowlist. If you use another root, another leaf count, or
`openEligibility`, the bind is refused with `root_mismatch`. Eligibility is
fixed when the sale is created and cannot be changed later.

Create the sale with the same Quote you uploaded the allowlist for. Each `cap`
is in that Quote's atoms, and neither the chain nor the bind checks the Quote:
a sale with another Quote would bind and serve proofs whose caps mean
something else.

Wait until the creation transaction is final (its effects are confirmed)
before you bind.

### 3. Bind the manifest to the sale

```sh
curl -sS "$BLAST/api/presale/allowlists/$ALLOWLIST_ID/bind" \
  -H "X-Blast-Api-Key: $BLAST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"presale_id":"0x<64 lowercase hex>"}'
```

- The body is exactly `{ "presale_id": "0x…" }`: the sale's object ID, `0x` and 64 lowercase hex characters, with no other key. It is at most 1 KiB.
- Blast reads the sale on chain. It binds the manifest only when the sale is allowlisted with this manifest's `root` and `leaf_count`.
- **200** `{ "allowlist_id", "presale_id", "root", "leaf_count" }`.
- A repeat bind is safe. It returns 200 and changes nothing.
- A sale's first binding is final. A later bind of another manifest with the same root and leaf count (the same rows) returns 200, and the sale keeps its first manifest. Its proofs are identical.

| Error | Status | Meaning |
| --- | --- | --- |
| `root_mismatch` | 409 | The sale is not allowlisted with this manifest's root and leaf count: another root, another count, an open sale, or no such sale. Nothing changed. If you created the sale moments ago, Blast's node may not show it yet: wait a few seconds and retry once. A second `root_mismatch` is final. |
| `not_found` | 404 | No manifest with this ID belongs to your key. |
| `invalid_parameter` | 400 | `{allowlist_id}` is not a manifest ID (a lowercase UUID). |
| `invalid_request` | 400 | The body is not exactly `{ "presale_id": "0x<64 lowercase hex>" }` as JSON. |
| `body_too_large` | 413 | The body is over 1 KiB. |
| `unauthorized` | 401 | The key or token is missing, unknown or revoked. |
| `deployment_unavailable` | 503 | Blast's presale deployment or its Sui node is unavailable. Retry after `Retry-After` seconds. |
| `deployment_mismatch` | 503 | Blast's node is on another chain. Retry later. |
| `origin_invalid` | 403 | A browser `Origin` from another site, with no API key. |
| `rate_limited` | 429 | Over the `presale_allowlist` budget, which creates and binds share. Wait for `Retry-After` seconds. |
| `service_unavailable` | 503 | Temporary. Retry after `Retry-After` seconds. |

### 4. Fetch a wallet's proof

Blast's API gate refuses an API call without the page cookie, except the
allowlist create, read and bind calls made with an agent key. The proof call
has no key exemption, so first load any Blast page with a cookie jar, then send
the proof requests with that jar:

```sh
curl -sS -c blast.cookies -o /dev/null "$BLAST/"
curl -sS -b blast.cookies -c blast.cookies \
  "$BLAST/api/presale/presales/$PRESALE_ID/proof?wallet=0x<64 lowercase hex>"
```

- The page cookie (`__Host-blast_gate`) identifies nobody and authorizes
  nothing: it only shows that a page of the site was loaded. It is separate
  from your API key and from a signed-in account, and it is not a credential
  to protect.
- It lasts two hours. A refusal is `401` with the header
  `X-Blast-Gate: required`. Its body, unlike the route errors below, is flat:
  `{"error":"gate_required","code":"gate_required","message":"…"}`. Detect it
  by the status and header, load a page again with the same jar, and retry
  once. `503` with `gate_unavailable` means the gate is not configured; retry
  later.
- Responses are `Cache-Control: no-store`.
- **200** `{ "index": "17", "wallet_cap": "500000000", "proof": ["<64 hex>", …] }`.
  - `index` and `wallet_cap` are decimal strings.
  - Each `proof` entry is 64 lowercase hex characters without `0x`, listed from the leaf to the root.
- If nobody bound the sale yet but it is allowlisted, Blast binds it to a stored manifest with the sale's root and leaf count, then answers.
- Verify the proof before committing:
  `verifyAllowlistProof(root, leafCount, { index: BigInt(index), wallet, walletCap: BigInt(wallet_cap), proof })`.
  Use the root and leaf count from the sale on chain.
- Commit with the SDK's allowlisted route, passing the same values as an `AllowlistProof`.

| Error | Status | Meaning |
| --- | --- | --- |
| `not_eligible` | 404 | The wallet is not on the sale's allowlist, or the sale is open (not allowlisted) or does not exist. |
| `allowlist_unknown` | 404 | The sale is allowlisted, but no stored manifest has its root and leaf count. Upload the same rows in the same order, then bind. |
| `invalid_parameter` | 400 | `{presale_id}` or `wallet` is not `0x` and 64 lowercase hex characters, or `wallet` is missing or repeated. |
| `deployment_unavailable` | 503 | Blast's presale deployment or its Sui node is unavailable. Retry after `Retry-After` seconds. |
| `deployment_mismatch` | 503 | Blast's node is on another chain. Retry later. |
| `origin_invalid` | 403 | A browser `Origin` from another site. |
| `rate_limited` | 429 | Over 120 proofs a minute from your IP. Wait for `Retry-After` seconds. |
| `invalid_request` | 400 | The request is malformed. |
| `body_too_large` | 413 | The request is too large. |
| `service_unavailable` | 503 | Temporary. Retry after `Retry-After` seconds. |

### Read a manifest

`GET /api/presale/allowlists/{allowlist_id}` with your key returns the same
summary as the create call.

| Error | Status | Meaning |
| --- | --- | --- |
| `not_found` | 404 | No manifest with this ID belongs to your key. |
| `invalid_parameter` | 400 | `{allowlist_id}` is not a lowercase UUID. |
| `unauthorized` | 401 | The key or token is missing, unknown or revoked. |
| `origin_invalid` | 403 | A browser `Origin` from another site, with no API key. |
| `rate_limited` | 429 | Too many requests. Wait for `Retry-After` seconds. |
| `invalid_request` | 400 | The request is malformed. |
| `body_too_large` | 413 | The request is too large. |
| `service_unavailable` | 503 | Temporary. Retry after `Retry-After` seconds. |

### Review a manifest's rows

`GET /api/presale/allowlists/{allowlist_id}/entries` with your key returns the
stored rows in leaf order and how they were built:

```json
{
  "quote": "0xdba3…::usdc::USDC",
  "source": { "file_name": "allowlist.csv", "uploaded_count": 3, "include_blast_holders": false, "added_count": 0, "holder_cap": null },
  "entries": [{ "wallet": "0x…", "cap": "500000000" }]
}
```

`added_count` is the number of card holders appended and `holder_cap` their
cap. Errors are the same as for reading the manifest.

## Errors and limits

Every error body is `{ "error": { "code", "message", … } }`. Route-specific
fields sit inside `error`, for example `rows`. Branch on `code`, never on
`message`.

The `Retry-After` header is sent with every 503 code
(`deployment_unavailable`, `deployment_mismatch` and `service_unavailable`)
and with `rate_limited`.

Rate limits:

| Bucket | Calls | Limit |
| --- | --- | --- |
| `presale_allowlist` | create and bind, together | 20 an hour per account or API key |
| `presale_proof` | proof | 120 a minute per IP |

Published JSON Schemas for every request, response and error are in the web
repository under `packages/core/src/modules/presale/contracts/schemas/`.
