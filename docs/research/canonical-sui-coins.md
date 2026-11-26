# Canonical Sui portfolio coins

Verified on 2026-10-14 against the search endpoint used by the official [Noodles app](https://app.noodles.fi/). Registry matches normalized, case-sensitive struct tags, never ticker strings. Only positive held balances receive the small-balance exception. Core holdings precede other holdings, with USD descending inside each tier; pages remain 20 rows.

| Coin | Category | Struct tag | Noodles source |
| --- | --- | --- | --- |
| SUI | Sui ecosystem | `0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=SUI) |
| WAL | Sui ecosystem | `0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=WAL) |
| DEEP | Sui ecosystem | `0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=DEEP) |
| BLUE | Sui ecosystem | `0xe1b45a0e641b9955a20aa0ad1c1f4ad86aad8afb07296d4085e349a50e90bdca::blue::BLUE` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=BLUE) |
| NS | Sui ecosystem | `0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=NS) |
| SCA | Sui ecosystem | `0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=SCA) |
| NAVX | Sui ecosystem | `0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=NAVX) |
| CETUS | Sui ecosystem | `0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=CETUS) |
| MMT | Sui ecosystem | `0x35169bc93e1fddfcf3a82a9eae726d349689ed59e4b065369af8789fe59f8608::mmt::MMT` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=MMT) |
| HAEDAL | Sui ecosystem | `0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=HAEDAL) |
| IKA | Sui ecosystem | `0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=IKA) |
| TURBOS | Sui ecosystem | `0x5d1f47ea69bb0de31c313d7acf89b890dbb8991ea8e03c6c355171f84bb1ba4a::turbos::TURBOS` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=TURBOS) |
| MAGMA | Sui ecosystem | `0x9f854b3ad20f8161ec0886f15f4a1752bf75d22261556f14cc8d3a1c5d50e529::magma::MAGMA` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=MAGMA) |
| US | Sui ecosystem | `0xee962a61432231c2ede6946515beb02290cb516ad087bb06a731e922b2a5f57a::us::US` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=Talus) |
| TRUTH | Sui ecosystem | `0x0a48f85a3905cfa49a652bdb074d9e9fabad27892d54afaa5c9e0adeb7ac3cdf::swarm_network_token::SWARM_NETWORK_TOKEN` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=TRUTH) |
| TAKE | Sui ecosystem | `0x76a49ebaf991fa2d4cb6a352af14425d453fe2ba6802b5ed2361b227150b6689::take::TAKE` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=TAKE) |
| XMN | Sui ecosystem | `0x97c7571f4406cdd7a95f3027075ab80d3e9c937c2a567690d31e14ab1872ccee::xmn::XMN` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=XMN) |
| DMC | Sui ecosystem | `0x4c981f3ff786cdb9e514da897ab8a953647dae2ace9679e8358eec1e3e8871ac::dmc::DMC` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=DMC) |
| TATO | Sui ecosystem | `0x04deb377c33bfced1ab81cde96918e2538fe78735777150b0064ccf7df5e1c81::tato::TATO` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=TATO) |
| haSUI | Liquid staking | `0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=haSUI) |
| vSUI | Liquid staking | `0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=vSUI) |
| afSUI | Liquid staking | `0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=afSUI) |
| stSUI | Liquid staking | `0xd1b72982e40348d069bb1ff701e634c117bb5f741f44dff91e472d3b01461e55::stsui::STSUI` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=stSUI) |
| sSUI | Liquid staking | `0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=sSUI) |
| USDC | Stablecoin | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=USDC) |
| suiUSDT | Stablecoin | `0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=suiUSDT) |
| USDsui | Stablecoin | `0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=USDsui) |
| suiUSDe | Stablecoin | `0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=suiUSDe) |
| USDB | Stablecoin | `0xe14726c336e81b32328e92afc37345d159f5b550b09fa92bd43640cfdd0a0cfd::usdb::USDB` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=USDB) |
| hashiBTC | Bitcoin | `0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06::btc::BTC` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=BTC) |
| WBTC | Bitcoin | `0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=WBTC) |
| suiWBTC | Bitcoin | `0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=suiWBTC) |
| xBTC | Bitcoin | `0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=xBTC) |
| LBTC | Bitcoin | `0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=LBTC) |
| tBTC | Bitcoin | `0x77045f1b9f811a7a8fb9ebd085b5b0c55c5cb0d1520ff55f7037f89b5da9f5f1::TBTC::TBTC` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=tBTC) |
| suiETH | Ethereum | `0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=suiETH) |
| SOL | Solana | `0xb7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=SOL) |
| XAUM | Real assets | `0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=XAUM) |
| XAGM | Real assets | `0x64bddec0f898ccaa022b8a6e0a5f75d80f53177b87a9795dd15aefe9ac12ee6c::xagm::XAGM` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=XAGM) |
| USDY | Real assets | `0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=USDY) |
| HIPPO | Community | `0x8993129d72e733985f7f1a00396cbd055bad6f817fee36576ce483c8bbb8b87b::sudeng::SUDENG` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=HIPPO) |
| LOFI | Community | `0xf22da9a24ad027cccb5f2d496cbe91de953d363513db08a3a734d361c7c17503::LOFI::LOFI` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=LOFI) |
| BLUB | Community | `0xfa7ac3951fdca92c5200d468d31a365eb03b2be9936fde615e69f0c1274ad3a0::BLUB::BLUB` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=BLUB) |
| MANIFEST | Community | `0xc466c28d87b3d5cd34f3d5c088751532d71a38d93a8aae4551dd56272cfb4355::manifest::MANIFEST` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=MANIFEST) |
| BRAT | Community | `0xd883b9dc7708547a4b578e3a4ec20a34c5fd866bc61caacbcb4330474032202e::brat::BRAT` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=5&scope=all&keyword=BRAT) |
| ONE | Community | `0xaaffd090b57fcdcf293f7e7ec59c119acc910eeb5fc4aadfb4185fa56b6a2cb5::suipump::SUIPUMP` | [Search](https://api-internal.noodles.fi/api/v1/global-search?limit=30&scope=coin&keyword=JustOneSui) |

Primary cross-checks: [Sui DeepBook contracts](https://docs.sui.io/onchain-finance/deepbook/deepbookv3/contract-information), [Scallop supported coins](https://github.com/scallop-io/scallop-skills/blob/master/references/supported-coins.md), [NAVI NAVX](https://naviprotocol.gitbook.io/navi-protocol-docs/dao-and-token/navx-tokenomics), [Turbos token address](https://turbos.gitbook.io/turbos/others/token-address).

WBTC here means LayerZero WBTC, separately from Sui Bridge suiWBTC and Wormhole WBTC. hashiBTC is Hashi BTC (added 2026-11-20): Sui mainnet GraphQL `coinMetadata` gives symbol `hBTC`, name `BTC`, 8 decimals and the description "BTC secured by hashi"; the registry shows it as `hashiBTC` (owner ruling, 2026-11-20) and names it Hashi BTC so it reads apart from the other BTC coins. It shares the `btc::BTC` struct name with suiWBTC under a different package. BLUE uses the official Bluefin original type; Noodles also returns other same-symbol entries, which are excluded. haSUI uses `hasui::HASUI`, not the unrelated `hsui::HSUI` type. The list is product curation, not a guarantee of investment safety.

Additional issuer cross-checks: [Bluefin BLUE](https://learn.bluefin.io/bluefin/more/blue-token), [Momentum publication](https://github.com/mmt-finance/mmt-coin/blob/main/Published.toml), [Momentum struct](https://github.com/mmt-finance/mmt-coin/blob/main/sources/mmt.move), [Bucket USDB](https://github.com/Bucket-Protocol/bucket-protocol-sdk/blob/v2/sdk/src/consts/config.ts), [Threshold tBTC](https://docs.threshold.network/contract-addresses/tbtc), [HIPPO](https://hippocto.meme/), [MANIFEST](https://systemisbroken.xyz/).

## 2026-11-20 refresh

Ten coins were added from the Noodles coin list (`POST https://api-internal.noodles.fi/api/v1/coin/list`, sorted by `LIQUIDITY`, `VOLUME_1D` and `MARKETCAP`, top 50 each), for 44 in all. A coin joined only when it was Noodles-verified, ranked in those lists, was the only verified coin with its symbol in Noodles search, and had a Cetus or Bluefin aggregator route from SUI on 2026-11-20. Sui mainnet GraphQL `coinMetadata` confirmed each struct tag and its decimals: MAGMA 9, US 9, TRUTH 8, TAKE 9, XMN 6, DMC 9, TATO 9, stSUI 9, BUCK 9, SOL 8. All ten Noodles logo URLs returned HTTP 200 with an image type.

| Coin | Name | Liquidity | 24h volume | Holders |
| --- | --- | --- | --- | --- |
| MAGMA | Magma Token | $1.56M | $2.57M | 18,050 |
| TRUTH | Swarm Network | $1.29M | $167k | 1,645 |
| US | Talus Token | $437k | $250k | 2,504 |
| BUCK | Bucket USD (v1) | $535k | $225k | 143k |
| stSUI | AlphaFi Staked SUI | $37k | $67k | 138k |
| SOL | Wrapped SOL (Wormhole) | $32k | $6.8k | 8,122 |
| DMC | DeLorean | $31k | $6.1k | 33k |
| TAKE | TAKE | $109k | $3.9k | 6,706 |
| XMN | xMoney Token | $43k | $3.8k | 2,618 |
| TATO | Pawtato | $67k | $1.4k | 2,419 |

Figures are Noodles snapshots from 2026-11-20 and only explain the selection.

Left out: FUD, SEND and haWAL (outside the top 50; see also the Suilend section below); Wormhole wUSDC `0x5d4b…::coin::COIN` and wUSDT `0xc060…::coin::COIN` (their on-chain symbols collide with native USDC and USDT, and they are legacy bridges); SVBTC, sUSN, BLUAI and ZUK (unverified or few holders); enzoBTC, eSUI, stBTC and xSUI (no volume); eEARN; Wormhole WBTC `0x0277…`; WETH, WARPED, FLX and JACKSON (low volume); VICTORY; and the unrelated `0x577a…::blast::BLAST` (name clash with Blast).

USDsui now sits third, after SUI and USDC, so it shows in the Blast mode lead without a search. Every coin here is listed in the Swap picker's More coins and in the Blast mode Ecosystem list, except BUCK, removed later the same day (see Suilend markets below).

## Suilend markets (2026-11-20)

Rule (owner, 2026-11-20): a coin with an active market in Suilend's main market, as https://suilend.fi/ shows it, is a main Sui coin and belongs in the list when it also passes the checks below. Reserves the site lists as deprecated do not count. Source: the reserves of Suilend's main lending market, object `0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1` (`LendingMarket<…::suilend::MAIN_POOL>`), read at version 1099671703 from public Sui mainnet GraphQL (`https://graphql.mainnet.sui.io/graphql`). It holds 46 reserves. Each reserve's `coin_type` was normalized and matched to this list by struct tag.

Already listed (21 reserves): SUI, USDC, SOL, DEEP, suiETH, HIPPO, NS, suiUSDT, BUCK, suiWBTC, BLUE, LBTC, WAL, HAEDAL, DMC, xBTC, IKA, WBTC, suiUSDe, USDsui and hashiBTC. The owner also named MANIFEST, LOFI, MAGMA, MMT, BLUE, CETUS and NS: all seven were already listed with the struct tags above. Of those, only BLUE and NS are Suilend main-market reserves. Seven of the 21 (HIPPO, NS, BUCK, BLUE, HAEDAL, DMC and IKA) are deprecated on Suilend too; they joined under the earlier Noodles rules, not this one. All but BUCK stay.

Added: sSUI, for 45 in all. It is Noodles-verified, its mainnet `coinMetadata` decimals match the reserve's `mint_decimals`, its Noodles logo returned HTTP 200, and it had a Cetus route from SUI on 2026-11-20. Its symbol is shared with a Scallop coin (below).

| Coin | Reserve index | Category | Decimals | Route from 0.1 SUI |
| --- | --- | --- | --- | --- |
| sSUI | 10 | Liquid staking | 9 | Cetus |

The site showed 15 active main-market coins on 2026-11-20: sSUI, SUI, USDC, USDsui, suiUSDT, suiUSDe, hBTC (hashiBTC), LBTC, suiWBTC, WBTC, xBTC, suiETH, SOL, DEEP and WAL. All but sSUI were already listed.

Removed on the owner's ruling (2026-11-20), because Suilend shows them only as deprecated: AUSD, FUD, SEND, mUSD, UP, KOBAN and ALKIMI. They were briefly added from the on-chain reserve list in #1015.

BUCK (Bucket USD v1) was removed on the owner's ruling the same day, taking the list from 45 to 44. USDB, Bucket's current dollar, stays.

sSUI is Suilend's SpringSui `spring_sui::SPRING_SUI`, listed under its on-chain name, Spring SUI. Noodles also verifies Scallop's `0xaafc…::scallop_sui::SCALLOP_SUI` under the symbol sSUI; that one is a different coin and is not listed.

Left out (17):

- Wormhole wUSDC `0x5d4b…::coin::COIN`, wUSDT `0xc060…::coin::COIN` and WETH `0xaf8c…::coin::COIN`: Wormhole copies of native USDC, suiUSDT and suiETH, which are listed.
- STEAMM LP bSUI-bUSDC: a liquidity-pool share, not a coin to trade.
- kSUI: no Noodles logo, and its on-chain icon URL returns HTTP 403. It does route from SUI.
- mSUI and trevinSUI: not Noodles-verified (about $3 and $2 of liquidity). Both route from SUI.
- iSUI: the route is capped. Any amount of SUI returns about 0.016 iSUI.
- fudSUI, upSUI, yapSUI, flSUI, oshiSUI, jugSUI, stratSUI, oSUI and fpSUI: no Cetus or Bluefin route from SUI.

## ONE (2026-11-20)

ONE (JustOneSui) was added on the owner's request, taking the list from 44 to 45. Its type is `0xaaff…2cb5::suipump::SUIPUMP`: `suipump::SUIPUMP` is the module and struct name SuiPump gives its launches, not the ticker. Sui mainnet GraphQL `coinMetadata` gives symbol `ONE`, name `JustOneSui` and 6 decimals, so the list shows ONE. Noodles verifies it (about $28k liquidity, $84k market cap, $2k 24h volume on 2026-11-20) and it is the only verified coin among about 30 that use the name JustOneSui or the ticker ONE; matching stays by struct tag, so those copies are never treated as listed. It had a Cetus route from 0.1 SUI, and its Noodles logo returned HTTP 200 as `image/jpeg`.

## Ecosystem coin pools and BRAT (2026-11-26)

On the owner's request, BRAT was added, taking the list from 45 to 46 (Noodles-verified, about $15k liquidity, $205k market cap on 2026-11-26; Sui mainnet GraphQL `coinMetadata` gives 9 decimals). CETUS, DEEP, NAVX, WAL, BLUB, LOFI and BRAT got a `poolKey`: each coin's deepest Cetus or Bluefin SUI pool, read on chain the same day (every `Pool<coin, SUI>` and `Pool<SUI, coin>` of both venues, both sides' reserves). All seven are Cetus pools with the coin as coin A. blast-infra tracks them from 2026-11-27 00:00 UTC; nothing earlier is filled. BRAT's pool (about 21.7k SUI, both sides) is thinner than ONE's (about 43k SUI), the template for a tracked pool; it is kept because the owner asked for it. MAGMA, BLUE, HAEDAL, US, MMT, TRUTH, SCA and TAKE were left without a pool: their deepest Cetus or Bluefin SUI pool was below ONE's.

## Logo resolution

CoinMark keeps the indexed metadata image first, then uses the exact canonical identity's Noodles logo when metadata is empty, unsafe, or fails to load. A copied ticker never receives another coin's logo. If both images fail, the stable generated placeholder remains; each failed URL is tried only once. No Noodles API requests are added at runtime.

Direct Sui mainnet gRPC `getCoinMetadata` reads on 2026-10-14 returned metadata for all 33 identities then listed and a nonempty icon URL for all except SUI (which already uses a bundled logo). They confirmed WAL's [on-chain icon](https://www.walrus.xyz/wal-icon.svg) and DEEP's [on-chain icon](https://images.deepbook.tech/icon.svg). Both issuer images responded successfully (Walrus follows an HTTPS redirect). All 33 Noodles fallback URLs returned HTTP 200 with an image content type. The earlier demo explicitly supplied null icon URLs; the app already reads indexed metadata, but lacked this fallback.

| Coin | Canonical fallback image |
| --- | --- |
| SUI | [Noodles logo](https://statics.noodles.fi/logo/9617893563456752127) |
| WAL | [Noodles logo](https://statics.noodles.fi/logo/9842075661773840743.png) |
| DEEP | [Noodles logo](https://statics.noodles.fi/logo/5953110395701421413.svg) |
| BLUE | [Noodles logo](https://statics.noodles.fi/logo/7418035000931445141.png) |
| NS | [Noodles logo](https://statics.noodles.fi/logo/15855495860326863293.svg) |
| SCA | [Noodles logo](https://statics.noodles.fi/logo/6731817061449729465) |
| NAVX | [Noodles logo](https://statics.noodles.fi/logo/12603559088759419719) |
| CETUS | [Noodles logo](https://statics.noodles.fi/logo/430711517704640244.png) |
| MMT | [Noodles logo](https://statics.noodles.fi/logo/8992504305779932469.png) |
| HAEDAL | [Noodles logo](https://statics.noodles.fi/logo/12890268452687820622) |
| IKA | [Noodles logo](https://statics.noodles.fi/logo/6956824444457421755.svg) |
| TURBOS | [Noodles logo](https://statics.noodles.fi/logo/10228209484758139380.jpg) |
| MAGMA | [Noodles logo](https://statics.noodles.fi/logo/11710130500610744212.svg) |
| US | [Noodles logo](https://statics.noodles.fi/logo/518008260956216517.svg) |
| TRUTH | [Noodles logo](https://statics.noodles.fi/logo/4420837639124659417) |
| TAKE | [Noodles logo](https://statics.noodles.fi/logo/2434502950356612760.svg) |
| XMN | [Noodles logo](https://statics.noodles.fi/logo/8369599583659785333.jpg) |
| DMC | [Noodles logo](https://statics.noodles.fi/logo/3442217361064770761.svg) |
| TATO | [Noodles logo](https://statics.noodles.fi/logo/14512794130289961358.png) |
| haSUI | [Noodles logo](https://statics.noodles.fi/logo/6334437972931383917.svg) |
| vSUI | [Noodles logo](https://statics.noodles.fi/logo/13189824273118543517.png) |
| afSUI | [Noodles logo](https://statics.noodles.fi/logo/16283540657745575935.svg) |
| stSUI | [Noodles logo](https://statics.noodles.fi/logo/15099714191308957683.png) |
| USDC | [Noodles logo](https://statics.noodles.fi/logo/12910532333836854800.png) |
| suiUSDT | [Noodles logo](https://statics.noodles.fi/logo/3350185613659011376.png) |
| USDsui | [Noodles logo](https://statics.noodles.fi/logo/3239126153783930158.png) |
| suiUSDe | [Noodles logo](https://statics.noodles.fi/logo/14382560914482753269) |
| USDB | [Noodles logo](https://statics.noodles.fi/logo/14137509526587240230.svg) |
| hashiBTC | [Noodles logo](https://statics.noodles.fi/logo/7821410237963526456) |
| WBTC | [Noodles logo](https://statics.noodles.fi/logo/3370065307328376599.svg) |
| suiWBTC | [Noodles logo](https://statics.noodles.fi/logo/16217097113231690579.png) |
| xBTC | [Noodles logo](https://statics.noodles.fi/logo/6316962245976570555.png) |
| LBTC | [Noodles logo](https://statics.noodles.fi/logo/4836990333763181976.png) |
| tBTC | [Noodles logo](https://statics.noodles.fi/logo/6867657403665242147.png) |
| suiETH | [Noodles logo](https://statics.noodles.fi/logo/10536657733227645780.png) |
| SOL | [Noodles logo](https://statics.noodles.fi/logo/4273538466776000573.jpeg) |
| XAUM | [Noodles logo](https://statics.noodles.fi/logo/16420821680781671352.png) |
| XAGM | [Noodles logo](https://statics.noodles.fi/logo/17108638301008921494.png) |
| USDY | [Noodles logo](https://statics.noodles.fi/logo/11307898973982214367.svg) |
| HIPPO | [Noodles logo](https://statics.noodles.fi/logo/12367217475693369235.png) |
| LOFI | [Noodles logo](https://statics.noodles.fi/logo/3577845151260351905.png) |
| BLUB | [Noodles logo](https://statics.noodles.fi/logo/4626651705687178628.jpg) |
| MANIFEST | [Noodles logo](https://statics.noodles.fi/logo/8816372507594642197) |
| sSUI | [Noodles logo](https://statics.noodles.fi/logo/11570756678430542905.png) |
| BRAT | [Noodles logo](https://statics.noodles.fi/logo/12540594340818269028) |
| ONE | [Noodles logo](https://statics.noodles.fi/logo/14207055064415664154.jpeg) |
