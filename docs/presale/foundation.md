# Presale web foundation

Every presale web route and worker builds on four shared parts. They come from T-008 of the presale backend workflow. The published payloads and error codes are in `packages/core/src/modules/presale/contracts/`. Gas sponsorship and its reservation table are in [`sponsor.md`](sponsor.md).

The presale worker processes, their configuration, job API, alerts, metrics and release gate are in [worker.md](worker.md) (T-009).

## Deployment identity

`PRESALE_DEPLOYMENT_MANIFEST` holds one JSON identity per network. The web app and the workers read the same value. The type and its validation are in `packages/core/src/modules/presale/deployment/`.

- **Validation.** The `presale` field goes through the SDK's own `PresaleCalls` normalization. Every other field is checked exactly, and an unknown key is refused. Commits are 40 lowercase hex characters.
- **Networks.** The network is `mainnet`, in every environment, tests and rehearsals included. Any other network name is `network_not_allowed` (a non-string is `malformed`), and a `chainIdentifier` other than mainnet's genesis digest is `network_mismatch`.
- **Production.** Production means the deployment identity is production: Vercel production, `BLAST_WORKER_ENVIRONMENT=production`, or `BLAST_DEPLOYMENT_TARGET=production`. It also refuses test IDs: any ID below 2^64, any of the SDK's own test manifest IDs, and the web fixture identity's IDs.
- **Fail closed.** A missing or malformed identity makes every identity route answer `503 deployment_unavailable`. Routes that do not need the identity keep working.
- **Chain check.** Before serving identity data, sponsoring, or signing, the gate compares `chainIdentifier` with the node's (`PRESALE_SUI_GRPC_URL`, else the mainnet fullnode). A different chain is `503 deployment_mismatch`. An unreachable node, or one that does not answer within 3 seconds (`PRESALE_NODE_TIMEOUT_MS`), is `deployment_unavailable` with `Retry-After`; that answer is never cached. Each check reads the chain identifier fresh, without the Sui client's cache, and an aborted read closes its request, so a node that stalled once is checked again on the next call.
- **Server node.** `PRESALE_SUI_GRPC_URL` (unset: the public mainnet fullnode) also selects the node for the server's other chain reads: trading, wallets and transfers, sales, vesting, wallet proofs, launchpad reads, the social worker's balances and the health probe (`mainnetNodeUrl` in `node.ts`). The value must be https in every environment; http is refused, loopback included. A refused value makes those reads unavailable; it never falls back to the public node. Outside production, a ready fixture identity with no `PRESALE_SUI_GRPC_URL` therefore reads the public mainnet fullnode: the presale shows as deployed, but the fixture IDs do not exist on mainnet, so reads return nothing and no transaction can run.

## Release gate: `npm run presale:release-check -w @blast/web`

Run this before every presale release or identity change. It blocks the release on failure. The script runs in `apps/web`, so give absolute paths.

```bash
npm run presale:release-check -w @blast/web -- --sdk <SDK worktree> --contracts <contracts worktree> [--manifest <identity.json>]
```

Without `--manifest`, it reads the identity from `PRESALE_DEPLOYMENT_MANIFEST`. It passes (exit 0) only when all of these hold:

1. The SDK worktree's `HEAD` is the identity's `sdkCommit`, with no uncommitted or untracked content.
2. The contracts worktree's `HEAD` is the identity's `contractsCommit`, with no uncommitted or untracked content.
3. The SDK's `abi/production-presale-v1.json` is pinned to that `contractsCommit`.
4. The SDK's `npm run check:abi`, given the contracts worktree, exits 0. This needs the Sui CLI version that the artifacts record. It is not run in a dirty SDK worktree.

Any failure exits 1. A usage error exits 2.

Use detached worktrees or clones at the two commits. Set `SUI_CONFIG_DIR` to a scratch directory so the Sui CLI leaves `~/.sui` alone.

## Route kit

`packages/core/src/modules/presale/route-kit/` provides `createPresaleRouteKit`. Production uses `presaleRouteKit()` from `apps/web/src/modules/presale/route-kit/runtime.ts`. Each route is declared with its published name, so it can only answer codes from that route's `PRESALE_ROUTES` error list.

A request goes through these steps in order:

1. **Origin.** A present `Origin` that is not `SITE_ORIGIN` is refused with `origin_invalid`. Agent API keys skip this rule.
2. **Auth.** `Authorization: Bearer <Privy access token>` gives the DID. A bearer token is not an ambient credential, so no CSRF cookie is needed.
3. **Rate bucket.**
4. **Deployment gate.**
5. **The handler.**

The default body cap is 64 KiB. Bodies are exact-key JSON (`readJsonBody`, `exactKeys`).

Errors use the shape `{ error: { code, message, ...extra } }`. They always carry `Cache-Control: no-store` and `X-Request-ID`. `Retry-After` is a header, sent on every 503, on `rate_limited`, and on `budget_exceeded`.

## Rate buckets

The buckets live in `packages/core/src/lib/web-security/rate-limits.ts`, registry version 7. Subjects are HMAC-SHA256 with `RATE_LIMIT_SUBJECT_PEPPER`. The `account` scope is keyed `account:<did>`. `account_or_api_key` falls back to `api_key:<id>` when no account is present.

| Bucket | Subject | Limit |
| --- | --- | --- |
| `presale_sponsor` | account | 30 / 10 min |
| `presale_sponsor_exec` | account | 100 / UTC day |
| `presale_allowlist` | account or API key | 20 / hour |
| `presale_proof` | IP | 120 / min |
| `presale_bridge_quote` | IP | 60 / min |
| `presale_bridge_register` | IP | 20 / 10 min |
| `presale_receipt` | IP | 60 / min |
| `presale_settings` | account | 30 / 10 min |
| `presale_reward_proof` | IP | 120 / min |
| `presale_outcome_commit` | IP | 60 / min |
| `presale_outcome` | IP | 30 / min |
| `presale_account_wallets` | account | 60 / 10 min |

Windows start at whole multiples of their length from the Unix epoch. The 86,400-second window is therefore exactly one UTC day.

## Embedded wallets

`resolveEmbeddedSuiWallet(did)` is in the Privy adapter (`createEmbeddedSuiWalletResolver`). It returns the user's Privy embedded Sui wallet: `chain_type` sui, `wallet_client_type` privy, `connector_type` embedded. Any login method works; no X account is needed. It never creates a wallet.

`packages/server/src/modules/presale/embedded-wallets/` caches DID → address in `presale_embedded_wallets` (migration 0039) with no expiry. The web runtime has `SELECT, INSERT` on that table.

| Case | Result |
| --- | --- |
| No embedded wallet (`require`) | `not_embedded_wallet` |
| No embedded wallet (`find`) | `null` |
| Privy outage on a cache miss | `503 identity_unavailable` with `Retry-After: 5` |
| Missing Privy settings on a cache miss | `503 service_unavailable` |
| Cached DID | Resolves during an outage |

## Account settings

`GET|PUT /api/account/settings` stores each signed-in account's explorer and theme. The handlers are in `packages/server/src/modules/presale/settings/`. They use the route kit with `auth: "account"` and the `presale_settings` bucket. The DID comes only from the Privy token.

- **Responses.** Every response is `{ explorer, theme, saved }`. `explorer` is `suivision` or `suiscan`. `theme` is `system`, `dark` or `light`.
- **GET.** Returns the account's saved values with `saved: true`. With nothing saved, it returns the configured defaults with `saved: false`.
- **PUT.** Takes exactly `{ explorer, theme }`, replaces both stored values, and returns them with `saved: true`.
- **Storage.** `presale_account_settings` (migration 0045) has one row per Privy DID. The web runtime has `SELECT, INSERT, UPDATE` on it. No role deletes a row.
- **Database.** The pool is resolved on each store call, not when the handlers are built.

The defaults come from two variables:

| Variable | Shipped default |
| --- | --- |
| `PRESALE_DEFAULT_EXPLORER` | `suivision` |
| `PRESALE_DEFAULT_THEME` | `system` |

An empty variable uses the shipped default. Any value outside the enum fails only a read that needs the default, with `503 service_unavailable`.

| Case | Result |
| --- | --- |
| No or invalid bearer token | `401 unauthorized` |
| JSON body with an unknown key, a missing key, an out-of-enum value, or not an object | `400 invalid_settings`, nothing stored |
| Body that is not JSON, or another content type | `400 invalid_request` (kit) |
| 31st request in 10 minutes for one account | `429 rate_limited` |
| Missing or invalid `DATABASE_URL` for a signed-in request | `503 service_unavailable` |

## Receipts

`GET /api/presale/receipts/{presale_id}/{wallet}/image?format=card|post` returns a participant's commitment receipt as a PNG, for the presale page's share action. The handlers are in `packages/server/src/modules/presale/receipts/`. They use the route kit with `auth: "none"` and the `presale_receipt` bucket per IP.

- **Image.** `card` is the 2100 × 1500 Mission Control card. `post` is the 1200 × 675 X layout, stored as the card image service's `share` format.
  - The image shows the sale coin's logo, the amount committed in Quote units, and the crew number when the wallet is linked to a crew member.
  - The page writes the share text; the image has none.
- **Record.** `blast.presale-receipt` v1 (`card-renderer/presale-receipt.ts`).
  - The amount is the latest commit's running `wallet_commitment` from blast-infra's `GET /v1/presales/{id}/wallets/{address}`. The coin types and the lifecycle come from `GET /v1/presales/{id}`.
  - Coin name, symbol and icon URL, and the Quote's symbol and decimals, come from the coins' on-chain `Currency` metadata, read from the presale identity's node.
  - The crew number comes from `mission_control_account_wallets` → profile → the latest season membership. It is null when that membership is suppressed and not restored.
  - `logo` holds the normalized logo PNG and its sha256, so a changed logo is a new record.
- **Renderer version.** `PRESALE_RECEIPT_RENDERER_VERSION` (`card-renderer/version.ts`), currently `presale-receipt-renderer/1`.
  - The image digest is sha256 over the canonical record and this version.
  - Bump it whenever the receipt's pixels can change. `presale-receipt.test.ts` pins a fingerprint of the layout, brand module and font inputs.
  - The layout takes its palette and primitives from `card-renderer/card-brand.ts`. `card-brand.test.ts` checks them against the season-zero artwork.
- **Cache.** Renders go through the card image service: memory, single flight, the shared render slots, the Blob store, and the catalog `presale_receipt_images` (migration 0046).
  - The catalog is keyed `(presale_id, wallet, format, record_digest)`. The web runtime has `SELECT, INSERT` on it; a row never changes and no role deletes one.
  - Identical record content renders once and returns byte-identical bytes.

**Logo fetch guard** (`receipts/logo.ts`). The icon URL is untrusted.

- HTTPS only, with no credentials in the URL, and at most 3 redirects.
- On every hop the host is resolved once, and every address must be public unicast. IPv6 must also be in `2000::/3`. The connection goes to that vetted address with `agent: false`, and TLS is checked against the host name.
- One 3 s budget covers DNS, connect, body and decode. DNS uses c-ares: each A and AAAA query is resent after 750 ms, up to 3 tries, and is cancelled when the budget runs out.
- At most 1 MiB, PNG, JPEG or WebP by content type, signature and decoder. SVG is refused. At most 4 Mpx. Decoding takes one of two per-process slots.
- The logo is drawn into a 512 px PNG square.
- Results are cached per process by URL: a logo for 10 minutes, a refusal for 1 minute.

Any refusal renders a monogram mark with `200`.

| Case | Result |
| --- | --- |
| Sale `open` | `Cache-Control: public, max-age=30, s-maxage=60` |
| Sale in any other lifecycle | `Cache-Control: public, max-age=3600, s-maxage=86400` |
| Monogram after a transient logo failure (timeout, network, DNS, 5xx, 429, 408), any lifecycle | the short `Cache-Control` |
| Monogram after a permanent refusal (no URL, not https, private address, content type, too large, not raster, other 4xx, redirects) | the lifecycle's `Cache-Control` |
| `format` missing, repeated or not `card`/`post`; malformed id or wallet | `400 invalid_parameter` |
| Wallet with no commit in the sale, or unknown sale | `404 not_found` |
| Renderer busy | `503 service_unavailable` with `Retry-After: 5` |
| blast-infra `not_ready` or unreachable; node or database failure; missing `Currency` metadata | `503 service_unavailable` with `Retry-After` |
| 61st request in a minute from one IP | `429 rate_limited` |

## Trust rules

- **Redaction.** Presale metrics go through `recordPresaleMetric` (`packages/core/src/modules/presale/redaction/`).
  - Secret names are matched word by word, singular or plural (`apiKeys`, `api_keys`, `X-API-Key`, `privKey`, `accessTokens`, `userSignatures`, `RATE_LIMIT_SUBJECT_PEPPER`). A field with such a name is dropped.
  - Presale vocabulary stays public: `token` and `auth` are secret only in a credential position (`gasPoolToken`, `authHeader`, `gasPoolAuth`), so `token_bps`, `tokens`, `auth`, `authMode`, `privateSale` and `signatureScheme` are kept.
  - In any string it removes the value after a secret name (`name=value`, `name: value`, `"name":"value"`, escaped JSON, `--name value`), bech32 and keystore (base64) private keys, JWTs, `Bearer`/`Basic` credentials, long base64 runs such as signatures, and CSV content.
  - A 44-character value starting with "A" is treated as a keystore key unless it is base58 and labelled as a digest (`digest: A…`).
  - Error messages are fixed text.
- **Signer guard.** `scripts/signer-guard.test.ts` fails if presale code creates or requests a signer. The only exceptions are the files it lists, which may hold at most three worker keys and one gas pool. Test files and the fixture files it names by path are exempt; a file is never exempt because of its name. Blast never signs for an embedded wallet; Privy signs in the browser.
