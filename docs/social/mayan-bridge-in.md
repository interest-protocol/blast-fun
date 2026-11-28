# Bridge in with Mayan: plan

Status: approved by Jose 2026-11-26 (`mayan-bridge-in-proposal.md`). The
bridge and token picker are both behind the bridge flag in PR #116.

Update 2026-11-28: on dev, the card prices and sends every route Mayan quotes
from these chains to Sui. Jose approved this "Mayan's way". See [Every route on
dev](#every-route-on-dev). Everywhere else the card is still Blink only, and the
sections below describe that unless they say otherwise.

## Goal

A person on Base, Ethereum, Arbitrum, Optimism, Polygon or Solana holds ETH,
POL, SOL, USDC, BONK or another token Mayan can route. They open Deposit in Blast, pick the chain and
token, type an amount, connect their wallet, sign once (twice for an ERC-20
that needs approval) and soon after SUI or USDC is in their Blast wallet. The
card is Blast's own UI on `@mayanfinance/swap-sdk`; nothing is framed or loaded
from Mayan's CDN. The recipient is always the signed-in person's Blast Sui
address and cannot be typed.

Success: a $2 Base ETH → SUI and a $2 Solana SOL → SUI bridge arrive in a Blast
wallet from the deployed site, the balance updates without a reload, and the
card passes the trader-arcade check in every state.

## What was proven (2026-11-26, scratch scripts, no wallets, no funds)

SDK `@mayanfinance/swap-sdk@16.1.0` (published 2026-11-24, `getSdkVersion()`
= `16_1_0`). Scripts and the scratch Next app are outside the repo.

| Route | Result | Quote time |
| --- | --- | --- |
| Base ETH → SUI | BLINK, 0.01 ETH → 25.23 SUI, min 24.70, auto slippage 2.07%, Mayan ETA 10 s | 0.3–1.3 s |
| Base USDC → SUI | BLINK, 20 USDC → 29.85 SUI | 0.4 s |
| Base ETH → Sui USDC | BLINK, 0.01 ETH → 16.89 USDC | 0.3 s |
| Base USDC → Sui USDC | BLINK, 20 → 19.98 USDC (9 bps); the fee is mostly fixed, about 31 bps at $5 and 3.5 bps at $100 | 0.1 s |
| Solana SOL → SUI | BLINK, 0.2 SOL → 21.15 SUI, Mayan ETA 1 s | 0.4 s |
| Solana BONK → SUI | BLINK | 0.5–0.8 s |
| Arbitrum ETH → SUI | BLINK | 0.5–0.8 s |
| Ethereum ETH → SUI | BLINK | 0.6–0.8 s |
| BSC (BNB, USDT, USDC) → Sui | `ROUTE_NOT_FOUND: invalid src_chain` | — |
| Base ETH, $1 | BLINK, works | 0.6 s |
| Base USDC 1,000 → SUI | BLINK refuses: `AMOUNT_TOO_LARGE`, `data.maxAmountIn` 300 (about 300 USDC, 0.17 ETH, 4.2 SOL). FAST_MCTP quotes it: 1,493 SUI, ETA 35 s | — |

- **BSC is out of v1.** BSC works as a source toward Base and Solana (SWIFT)
  but no route reaches Sui today, although `/v3/chains` lists BSC as active.
- **BLINK only** (with every route off). The SDK's defaults also allow WH, SWIFT, MCTP and Shuttle.
  Quotes with `{ blink: true }` and every other route `false` worked for Base
  USDC, Arbitrum ETH, Ethereum ETH and Solana BONK. `decodeBlinkQuote(quote.blinkQuote)`
  exposes `orderParams.recipient` (the Sui address) and `orderParams.refundAddress`
  (the source wallet). A bound order expires about 30 minutes after the quote
  (`expiresAt`; `isBlinkQuoteExpired`).
- A BLINK quote is swappable only when fetched with `destinationAddress` and
  `swapperAddress`. Bound and unbound quotes returned the same price.
- Transaction building, unsigned: `getSwapFromEvmTxPayload` built the Base ETH
  deposit (to the Blink escrow, `value` = amount, no approval) and the Base USDC
  deposit (needs an ERC-20 approval). `createSwapFromSolanaInstructions` built
  SOL → SUI for a funded public address (10 instructions, 3 lookup tables); for
  an empty address it refuses with "swap would fail on-chain".
- Browser: a scratch app on the web app's exact versions (Next 16.4.6
  Turbopack, React 19.3.0, `@mysten/sui` 3.0.1, viem 2.57.4) built, type
  checked, and in headless Chromium fetched a Base → Sui quote and built the
  transaction. CORS is open on `price-api`, `blink-api`, `explorer-api`.
- Dependencies: the SDK depends (not peer) on `@mysten/sui@^2.17`, `ethers@6`,
  `@solana/web3.js@1`. npm nests `@mysten/sui@2.39.1` under the SDK beside the
  app's 3.0.1; nothing crosses between them because Sui is only the
  destination. The SDK imports Node's `buffer`; Turbopack resolved it with no
  config. Lazy chunks about 280 KB gzip (SDK 114 KB, ethers 140 KB, rest 27 KB).
- Status and history: `explorer-api.mayan.finance/v3/swap/trx/{sourceTxHash}`
  returns `clientStatus` (`INPROGRESS`, `COMPLETED`, `REFUNDED`) and `toAmount`.
  `/v3/swaps?trader={sui address}&limit=N` lists the swaps an address sent or
  received; the card keeps those with `destChain` 21 (Sui) and `destAddress`
  equal to the Blast address. `destAddress=` refuses a Sui address
  (checked 2026-11-26). History needs no Blast server.

## Where the card lives

Jose, 2026-11-26: its own **Bridge** button, beside Deposit and Withdraw.

- Order everywhere (Jose, 2026-11-26): Deposit, Withdraw, Bridge. Deposit
  stays primary; Bridge is a secondary button with an arrow-into-wallet icon,
  label "Bridge".
- Places, all opening the coin sheet on the new `bridge` screen through a
  new shell action `openBridge` (`firstScreen("bridge")` in `coin-model.ts`):
  - Portfolio header on desktop (`PortfolioView.tsx` `actsD`) and the
    "Funding" row on phones (`actsM`), plus the loading skeleton
    (`PortfolioLoading.tsx`) so the row does not jump.
  - Settings wallet card (`WalletCard.tsx`, `onBridge`).
  - A coin's screen in the sheet (`CoinSheet.tsx` `quietActs`), beside
    Deposit and Withdraw.
  - The Fund screen (`depositScreen(true)`, opened by `openFund`): today it is
    the address plus a Withdraw button. It becomes the address, then
    Withdraw, then Bridge, so Fund offers all three ways.
- Deposit stays as it is: address, QR, "Send coins on the Sui network only."
  That note is right for Deposit, because Deposit is only for coins already on
  Sui. No bridge row inside Deposit.
- `bridge` is a new `CoinScreen` kind (`parseCoinScreen`, `SCREEN_LABEL`
  "Bridge to Sui"), so it survives the OAuth restore like the others. Back
  from the screen closes the sheet when it was opened by the Bridge button.
- With the flag off, no Bridge button anywhere.
- Check the phone row with three large buttons at 320 px wide; if labels
  wrap, the phone row uses icon-over-label buttons for all three.

## Source tokens

Each chain starts with its native coin and canonical USDC. The picker loads
Mayan's verified ERC-20, SPL or Token-2022 catalog for the selected chain and
searches by name, symbol or address. It opens over the bridge as a centered
desktop dialog and a bottom sheet on phones. Selecting a token still requires a Blink
route for the amount and destination. These routes may swap on the source
chain and use a different approval spender, which `getEvmSwapApproval` chooses.

## Card layout and states

From the top, Aftermath's order minus what a deposit does not need:

1. **From**: a chain menu, then the chain-specific Connect or Switch action
   when needed. The send field holds the token picker and amount. A loaded
   source balance reveals 25%, 50%, 75% and Max below the amount. The shortcuts
   keep gas back for native tokens.
2. **To**: SUI or USDC, "Your Blast wallet" with the shortened address through
   `CopyAddress`. Never an input.
3. **Quote rows** (once a quote exists): one sentence ("Send 20 USDC from
   Base. You get at least 29.39 SUI."), then Fee (source token and USD; USD
   only for USDC) and Arrives (Mayan's `etaSeconds`, "about 10 s"). Slippage
   is Mayan's auto value, folded into "at least", not a row. "Powered by
   Mayan" footer.
4. **One primary button**. Connect and Switch sit under the source chain.
   Sign in, Approve, and Bridge sit below the transfer details.
5. **Recent bridges** below the card: last 5 from the explorer by the Blast
   address, the pending one first. Read on open and retry briefly for transfers
   this tab submitted that the explorer has yet to list.

One direction only: other chains → Sui. No flip, no Sui → other chain, no swap icon that suggests two ways. Title "Bridge to Sui"; the Bridge button icon is an arrow into the wallet.

| State | Shown |
| --- | --- |
| Signed out | Inputs live (unbound quotes are public); button "Sign in" |
| No source wallet | Unbound preview quote; "Connect {chain} wallet" under From |
| Wrong network (EVM) | "Switch to {chain}" under From (`switchChain`) |
| Quoting | Skeleton rows; previous numbers dimmed, never blank |
| Quote error | `ROUTE_NOT_FOUND` → "No route from {chain} {token} to Sui right now"; limits → Mayan's min/max in plain words; network or 429 → "Couldn't get a price" after backoff, and the button becomes "Try again" |
| Above the BLINK cap | `AMOUNT_TOO_LARGE` → "The largest amount is 300 USDC" (Mayan's `maxAmountIn`); the button stays disabled. With every route on, Fast MCTP takes larger amounts (below) |
| SDK outdated | `fetchQuote` code 9999 "Swap SDK is outdated!" → card says "Bridging is paused. You can still deposit on Sui"; the inputs lock; logs an error so we upgrade |
| Insufficient balance | "Not enough {symbol}" (native includes source gas) |
| Approval needed | "Approve {symbol}" (approve tx), then "Bridge" |
| Signing | `LoadingIndicator` "Confirm in your wallet" |
| Rate changed | The fresh quote at click is below the shown minimum: show new numbers, button "Bridge at new rate" |
| Wallet or chain changed | Source account or chain changes after binding: drop the bound quote, re-quote |
| Blast session changed | Sign-out or account switch: close the card's quote and pending state, return to Deposit |
| On the way | Pending row: amounts, Mayan's ETA, "View on Mayan" |
| Arrived | Row turns "Arrived · 25.2 SUI"; balances refresh; one quiet toast |
| Refunded | "Refunded to your {chain} wallet" with the explorer link |
| Wallet rejected | Back to the Bridge button, no error banner |

## Wallet flow (Privy)

People sign in to Blast with X or Google; their Blast Sui wallet is Privy's
embedded wallet. The source wallet is a separate external one. **Nothing in
`apps/web/src` connects an external EVM or Solana wallet for a signed-in person
today**, so this is new. Before writing code, verify in
`node_modules/@privy-io/react-auth` 3.52:

- the connect-only hook (`useConnectWallet` or its 3.x name) does not link the
  wallet to the account and does not change `user.wallet`
  (`SocialSession.tsx:45` passes `privy.user?.wallet` to `useRestorePrivyWallet`);
- the option that opens only EVM or only Solana wallets;
- `useWallets` (EVM) and `@privy-io/react-auth/solana` `useWallets` /
  `useSignTransaction`, and the signer's byte format;
- `supportedChains` must include Base, Arbitrum and Ethereum for `switchChain`.

**Verified in `node_modules` (Privy 3.52.0, 2026-11-26):**

- `usePrivy().connectWallet({ walletChainType, walletList? })` (also
  `useConnectWallet`) opens the connect-only screen. That screen has no SIWE
  and no link step; `linkWallet` is the separate SIWE link flow. `user.wallet`
  comes from linked accounts, so connect-only leaves it unchanged.
- The chain filter is `walletChainType: "ethereum-only" | "solana-only" |
  "ethereum-and-solana"`.
- EVM `useWallets()` gives `ConnectedWallet` with `address`, `chainId`
  (`"eip155:8453"`), `switchChain(0x… | number)` and
  `getEthereumProvider(): Promise<EIP1193Provider>`.
- `@privy-io/react-auth/solana` `useWallets()` gives `{ ready, wallets }`;
  `useSignTransaction().signTransaction({ transaction: Uint8Array, wallet })`
  returns `{ signedTransaction: Uint8Array }`. So `sign` serializes the
  web3.js transaction to bytes and deserializes the signed bytes.
- No `supportedChains` is set in our config, so Privy uses
  `DEFAULT_SUPPORTED_CHAINS` from `@privy-io/js-sdk-core`, which includes
  Ethereum (1), Arbitrum One (42161) and Base (8453). No config change.
- `PrivySessionProvider` wraps every page while `PRIVY_APP_ID` is set, for
  both Privy and Slush Blast accounts; the bridge shows only when
  `usePrivySessionMounted()` is true.

The wallet list: `PrivyAuthProvider` with `deferWalletPicker` lists only
detected wallets until `usePreparePrivyWalletPicker(true)` runs, which today
happens only for signed-out people (`SignIn.tsx:271, 325`). The bridge screen
calls it while open so WalletConnect QR and Coinbase show.

- **EVM:** the SDK builds the request with `getSwapFromEvmTxPayload(..., {
  evmProvider })` on Mayan's RPC for that chain; the wallet sends it through its
  EIP-1193 provider (viem wallet client). Approvals use `getEvmSwapApproveTxs`
  only. No permits in v1: `Erc20Permit` is `{v, r, s}`, which smart-contract
  wallets (Coinbase Smart Wallet, Base Account) cannot produce. Never set
  `allowBlinkEvmDirectTransfer`. After an approval confirms, re-quote and run
  `isEvmSwapAllowanceEnough` on the fresh quote before the deposit (slow
  Ethereum approvals can outlive the price).
- **Solana:** `swapFromSolana(quote, swapper, dest, null, sign, connection,
  ..., { onTransactionSigned })`. Always pass our `Connection` (on Mayan's
  Solana RPC); without it the SDK falls back to `rpc.ankr.com`. `sign` serializes the SDK's web3.js
  transaction, has Privy sign the bytes, and deserializes it.
  `onTransactionSigned` records the signature at once so the pending row
  exists even if sending is slow.
- **With every route off, quotes are BLINK only:** `fetchQuote(params, { blink: true, swift: false,
  mctp: false, fastMctp: false, wormhole: false, shuttle: false, monoChain:
  false, gasless: false })`. Refuse any quote with `type !== "BLINK"` or
  without a Blink order (`hasBlinkQuoteHash`).
- **Recipient and refund guard** (Blink; see below for the MCTP routes): one synchronous check before any wallet
  call: `decodeBlinkQuote(quote.blinkQuote).orderParams.recipient` equals the
  Blast address and `refundAddress` equals the connected source wallet
  (`sameBlinkAddress`). The SDK's own `resolveBlinkOrder` checks the order
  against the quote; ours checks it against the Blast session, which the SDK
  cannot know.
- `destinationAddress` comes only from the sheet's `wallet.address` (Blast
  session). That works for both Blast account kinds: a Privy account (its
  embedded Sui wallet, created on first use in `CoinsHost.tsx`) and a Sui
  wallet account such as Slush (`wallet.signer` is not `"privy"`). The bridge
  never signs on Sui, so the Sui signer kind does not matter; wait for
  `wallet.address` to be non-null (Privy may still be creating it). Slush is
  Sui-only, so it is never the source wallet; the source is always an EVM or
  Solana wallet connected through Privy. Tests and the live check cover a
  Privy account and a Slush account.

## Dependencies and loading

- Add `@mayanfinance/swap-sdk` exact `16.1.0`, `ethers@^6`,
  `@solana/web3.js@^1` to `apps/web` (our code constructs `JsonRpcProvider`,
  `Connection`, `VersionedTransaction`; same ranges as the SDK so npm dedupes).
- Supply chain: 16.1.0 was published two days before this plan and handles
  user funds. Before the flag goes on, read the diff from the previous minor
  (`npm diff`), and keep the lockfile integrity hashes. Upgrades are explicit
  PRs; a 9999 "outdated" error is the signal to make one.
- The `bridge` screen body is a `React.lazy` boundary; nothing from these
  packages enters any route's first-load JS. Compare the build route table
  before and after.

## Configuration

Read on the server (`lib/web-config.ts`) and passed to the client as a
boolean:

- `NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED=1` shows the Bridge buttons (ship dark).
- RPCs: Mayan's own, `https://front-rpc.mayan.finance/<chain>`, the one its
  widget uses (open CORS, no key). Jose's ruling 2026-11-26: no custom RPCs and
  no RPC variables, so every chain is always shown.
- Chains: Base, Ethereum, Arbitrum, Optimism, Polygon and Solana. Each has a
  BLINK route to Sui (checked against live quotes 2026-11-26). Unichain, Linea,
  Avalanche and Monad quote only FAST_MCTP; BSC has no route.
- Referrer fee: **0%, Jose's ruling 2026-11-26.** v1 sends no referrer and has
  no fee setting. If a fee is wanted later, Mayan's `ChainReferrers` needs an
  `evm` address (Base, Ethereum, Arbitrum, Optimism, Polygon sources) and a `solana` address,
  passed identically to `fetchQuote` (`QuoteOptions.referrers`, without
  `referrerBps`) and to the swap call.

## Content Security Policy

CSP is built per request in two places: `apps/web/src/proxy.ts` and
`apps/web/src/lib/web-security/partner-response.ts`, both through
`securityHeaders` in `browser-policy.ts`. Add a `bridgeConnectSources`
input beside `presaleConnectSources`, set in both, only while the flag is on:

- `https://price-api.mayan.finance` (quotes, token lists)
- `https://blink-api.mayan.finance` (BLINK orders, Solana instructions)
- `https://explorer-api.mayan.finance` (status, history, Jito submit)
- `https://front-rpc.mayan.finance` (balances, gas, the Solana send)
- Exactly the further hosts the SDK reaches on our paths, captured from a
  browser run of EVM ETH, EVM USDC and Solana SOL. No wildcards.

Chain and pinned coin logos are local files in `public/blast-ui/`. The picker
loads other tokens' logos over HTTPS, which `img-src` already allows.
Test both builders, flag on and off, in `web-security.test.ts`.

## Quotes and the Scale rule

- Quotes go from the browser to Mayan through the SDK. No Blast route.
- TanStack Query, key `[from chain, token, amountIn64, to token, swapper,
  destination]`. Debounce 400 ms after typing. **No interval refresh**: each
  bound quote creates an order at Mayan. Re-quote when the input changes, when
  the screen becomes visible again after 60 s, and once at click.
- `fetchQuote` takes no `AbortSignal` and is a POST: stale responses are
  ignored by key, not cancelled, and count in the RPS figures. Retry 429 and
  5xx with exponential backoff (1 s, 2 s, 4 s, then stop). With every route on,
  a 429 is never retried.
- At click: fresh bound quote; refuse if `isBlinkQuoteExpired`; compare with
  the shown minimum; then sign.
- Source balance: one RPC read per (wallet, chain, token) change and after a
  submit. Not polled.
- Status: poll `swap/trx/{hash}` every 5 s while pending and visible; stop on
  `COMPLETED` or `REFUNDED`; after 30 min stop and show "Still on the way —
  check on Mayan".
- On `COMPLETED`: `useBalancesContext().changed()` (`coins/balances.tsx`),
  which invalidates the wallet, portfolio, presales and transactions reads
  through `invalidateAfter`. These four reads are the only Blast-origin
  requests this feature adds, once per completed bridge.

PR line (to be filled with measured values):

| Path | Per active card | 10,000 visible tabs, 1% typing | All 10,000 typing |
| --- | --- | --- | --- |
| Blast origin | 0; 4 reads per completed bridge | ~0 rps | ~0 rps |
| price-api.mayan.finance | ≤ 2.5 rps while typing (debounced), 0 at rest | ≤ 250 rps bursts, ~0 at rest | unmeasured |
| explorer-api (status and history) | 0.2 rps per pending bridge, plus 0.2 rps while this tab waits for a recently submitted hash to be indexed | bridges in flight × 0.2, plus 0.2 per tab waiting for the index | ≤ 2,000 rps per poll type if all 10,000 tabs qualify |
| Source RPC (Mayan's `front-rpc`) | balance reads per input change; Solana send + SDK retries (`submitTransactionWithRetry`) per bridge | per committed action | — |

Mayan's rate limits are unknown: mark unmeasured and ask Mayan for an API key
(`QuoteOptions.apiKey`) and limits before turning the flag on for everyone.

## Pending state across reloads

The explorer is the record. In memory, the card keeps the just-signed source
hash (from `onTransactionSigned` or the EVM send) until `/v3/swaps?trader=`
lists it, so the pending row shows at once. For a reload before indexing, the
tab keeps only submitted hashes and timestamps in account-scoped session
storage. While the tab is visible it checks history every five seconds until
Mayan lists those hashes or one minute has passed since submission. Mayan
supplies all amounts and status.

This rule holds for Mayan because the explorer finds every order by its Sui
destination address, which is always the Blast address: an EVM hash lost to a
reload during a wallet hand-off still shows up. A Blast-run CCTP route would
need one narrow record instead (its burns are minted only once Blast hears the
hash); Jose ruled on 2026-11-26 that Blast does not run its own CCTP, so no
such record exists.

Activity gap: Mayan bridges are not in Blast's transaction log, so the
Activity list does not show them. Release 1 accepts this; the card's recent
bridges and the arrival toast cover it.

## USDC and Circle

Mayan carries every bridge, USDC included (Jose, 2026-11-26). Blast does not
run its own CCTP: its Sui relayer was deleted and only minted CCTP V1, so it
is not ready to come back. The server-side CCTP code stays untouched and
unlinked. When From is USDC, To defaults to USDC (the person can still pick
SUI). Large USDC amounts reach Circle CCTP V2 through Mayan's FAST_MCTP.

## Every route on dev

Jose, 2026-11-28: "Yes, follow the Mayan way, please." On the `dev` Vercel
environment (`bridgeFastMctp` in `lib/web-config.ts`) the card takes every route
Mayan quotes from its six chains to Sui. With the switch off, the card sends the
same Blink-only request as before and refuses any other route before a wallet
call.

- **One request.** `fetchQuote` with `blink`, `fastMctp`, `mctp` and
  `fullList`. The card takes the first that passes its check: Fast MCTP (about
  35 s), then MCTP, then Blink.
- **What we check (ours).** The quote that comes back matches what we asked:
  chains, source coin and amount, coin on Sui, no referrer, no gas drop, not
  gasless, a minimum no higher than the estimate, slippage of at most 500 bps
  (the most Mayan's price API documents for `slippageBps`), and not expired.
  The destination we give the SDK is the signed-in Blast Sui address.
- **How we send: Mayan's way.** For MCTP and Fast MCTP the SDK builds the
  transaction (`getEvmSwapApproveTxs`, `getSwapFromEvmTxPayload`,
  `swapFromSolana`). The card does not decode it. Approvals are signed as the
  SDK returns them, one receipt at a time: an old Ethereum USDT allowance takes
  two. No permits. A Blink order is still read in full, as above.
- **Refunds.** Blink refunds the source wallet. MCTP and Fast MCTP pay a USDC
  refund to the Blast wallet on Sui, minus a refund fee. Recent bridges names
  the right wallet for each, whether the switch is on or off.
- **The card.** One sentence above the button says what leaves, the least that
  arrives and where a refund goes. Fee adds Mayan's relayer fee, protocol fee
  and Circle fee, and shows "—" if one is missing. There is no Route row.
- **Errors.** No route: "No price for ARB. Bridge USDC." (for USDC, "Try
  another chain."). Too large: "Largest right now: 75.94 ETH." when Mayan's
  message gives a number, else "Try a smaller amount."
- **Retries.** Only network and server errors, never a 429. The SDK drops the
  HTTP status, so this reads its error shapes in 16.1.0: every refusal has a
  `data` key and Mayan's own 5xx answer has none. Check it again on each SDK
  upgrade; the card tests run the real SDK against a local price API.
- **Loss check (Jose, 2026-11-28).** At the send press the card compares the
  dollars sent with the minimum received, in Blast's own prices. Up to 3%: one
  press. Above 3%: a pop-up names the loss and a second press sends. Nothing is
  blocked. When only the fixed fee puts it above 3%, it says "Send more". A
  price that is missing or more than 120 seconds old also opens the pop-up
  ("Loss unknown"). Blast has no price for POL or most tokens, so those always
  ask.
- **Requests.** Mayan: one POST per settled amount, at most 2.5 per second for
  a card being typed in; at 10,000 visible tabs with 1% typing, 250 per second
  (calculated). Each POST asks three routes; how Mayan counts that is
  unmeasured. Blast: at most one batched price read per send press, reused for
  10 seconds, with no polling. Per send, only the SDK's chain reads
  (unmeasured). Explorer polling is unchanged. Ask Mayan for an API key and its
  limits before production.
- **Before production.** One small real bridge per call shape, signed by Jose.

## Tests

Node test runner (`npm test -w apps/web`), as the coin sheet tests do:

- `bridge-model.test.ts` (pure): amount → `amountIn64`; Max keeps each native coin's gas reserve; quote → rows; `clientStatus` → row state; button label for
  every state above.
- Guard: refuse a non-BLINK quote, a quote without a Blink order, a recipient
  other than the Blast address, a refund address other than the source wallet,
  an expired quote; each before any wallet call.
- `BridgeForm.dom.test.tsx` with a fake SDK module and fake wallets: every
  state in the table; 9999 error; wallet rejection; rate changed; allowance
  re-check after approval on a fresh quote; wallet/chain change drops the bound
  quote; arrival calls `changed()` once.
- `coin-model.test.ts`: `bridge` parses and restores.
- `web-security.test.ts`: Mayan origins in both CSP builders, only with the
  flag on.
- Build: no Mayan, ethers or `@solana/web3.js` code in any route's first-load
  JS; only the Bridge buttons and the lazy-screen entry (about 1.4 KB gzip on
  social routes). The lazy chunk exists.
- Browser (local, `next dev -H 127.0.0.1`): screenshots of every state, light
  and dark, phone and desktop, via the Blast UI skill and the trader-arcade
  check.
- Live (after deploy, flag on for the team): $2 Base ETH → SUI and $2 Solana
  SOL → SUI into a team Blast wallet, then $2 Base USDC → SUI for the approval
  path. A team wallet funds these.

## Out of scope for v1

BSC, bridge out of Sui, destinations other than SUI and USDC, permits and
gasless orders, slippage editing, gas drop, and a referrer fee.

## PR shape

PR #116 on `feat/mayan-bridge` includes config, CSP, the bridge card and
buttons, the picker, guards and tests. The PR records request estimates,
Modern Web Guidance, screenshots and bundle measurements.
