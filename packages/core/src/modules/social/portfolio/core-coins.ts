import { normalizeStructTag } from "@mysten/sui/utils";
import { SUI_COIN_TYPE, SUI_USDT_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/** Blast V1 coins by mainnet type. Jose confirmed the deployer for each marked entry. */
export const BLAST_V1_COINS = [
  { symbol: "MANIFEST", name: "MANIFEST", decimals: 9, category: "Legacy", coinType: "0xc466c28d87b3d5cd34f3d5c088751532d71a38d93a8aae4551dd56272cfb4355::manifest::MANIFEST", logoUrl: "/blast-ui/coins/v1-manifest.jpg", poolKey: "cetus:0x0e40203fe4290967117b69be99785dd3a4798bc92e5ec460177f842309430a0d", verifiedTeam: true },
  { symbol: "Wheels", name: "Blast Wheels", decimals: 9, category: "Legacy", coinType: "0x6a9c2ded791f1eea4c23ac9bc3dbebf3e5b9f828a9837c9dd62d5e5698aac3ee::wheels::WHEELS", logoUrl: "/blast-ui/coins/v1-wheels.jpg", poolKey: "bluefin:0x80fb27ef521bf319a4218953538b251e65934eab55d160149aae77a58ca4e1b6", verifiedTeam: true },
  { symbol: "BLAST", name: "OurBlastBot", decimals: 9, category: "Legacy", coinType: "0x577a8addf60a34d4c705914ad066a3b28c3fc40d365ed0d9dfc408f29b4725d3::blast::BLAST", logoUrl: "/blast-ui/coins/v1-ourblastbot.jpg", poolKey: "bluefin:0x4e5fa326153868e9a023ce07b8dde5370e92e01824834abbab892540b42ec29c", verifiedTeam: true },
  { symbol: "HELMET", name: "Trench Helmet", decimals: 9, category: "Legacy", coinType: "0x1c1d9ff4d3ab6f819cab3601cc3089b149a9b18dd8c9fd24e5bfcf63f1d4236f::helmet::HELMET", logoUrl: "/blast-ui/coins/v1-helmet.jpg", poolKey: "cetus:0x16ce327a5406aecff8a1f3a0d4ef2d6304ff43a009fe0521c89bb2864fe1a9d2", verifiedTeam: true },
] as const;

/** User-curated ecosystem identities; source verification is recorded in docs/research/canonical-sui-coins.md.
 * Decimals were read from each type's mainnet coin metadata on 2026-11-20. */
export const CORE_COINS = [
  { symbol: "SUI", name: "Sui", decimals: 9, category: "Sui ecosystem", coinType: SUI_COIN_TYPE, logoUrl: "https://statics.noodles.fi/logo/9617893563456752127" },
  { symbol: "USDC", name: "USD Coin", decimals: 6, category: "Stablecoin", coinType: USDC_COIN_TYPE, logoUrl: "https://statics.noodles.fi/logo/12910532333836854800.png" },
  { symbol: "USDsui", name: "USDsui", decimals: 6, category: "Stablecoin", coinType: "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI", logoUrl: "https://statics.noodles.fi/logo/3239126153783930158.png" },
  { symbol: "hashiBTC", name: "Hashi BTC", decimals: 8, category: "Bitcoin", coinType: "0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06::btc::BTC", logoUrl: "https://statics.noodles.fi/logo/7821410237963526456" },
  { symbol: "WAL", name: "Walrus", decimals: 9, category: "Sui ecosystem", coinType: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL", logoUrl: "https://statics.noodles.fi/logo/9842075661773840743.png" },
  { symbol: "DEEP", name: "DeepBook", decimals: 6, category: "Sui ecosystem", coinType: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP", logoUrl: "https://statics.noodles.fi/logo/5953110395701421413.svg" },
  { symbol: "BLUE", name: "Bluefin", decimals: 9, category: "Sui ecosystem", coinType: "0xe1b45a0e641b9955a20aa0ad1c1f4ad86aad8afb07296d4085e349a50e90bdca::blue::BLUE", logoUrl: "https://statics.noodles.fi/logo/7418035000931445141.png" },
  { symbol: "NS", name: "SuiNS Token", decimals: 6, category: "Sui ecosystem", coinType: "0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS", logoUrl: "https://statics.noodles.fi/logo/15855495860326863293.svg" },
  { symbol: "SCA", name: "Scallop", decimals: 9, category: "Sui ecosystem", coinType: "0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA", logoUrl: "https://statics.noodles.fi/logo/6731817061449729465" },
  { symbol: "NAVX", name: "NAVX Token", decimals: 9, category: "Sui ecosystem", coinType: "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX", logoUrl: "https://statics.noodles.fi/logo/12603559088759419719" },
  { symbol: "CETUS", name: "Cetus Token", decimals: 9, category: "Sui ecosystem", coinType: "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS", logoUrl: "https://statics.noodles.fi/logo/430711517704640244.png" },
  { symbol: "MMT", name: "Momentum", decimals: 9, category: "Sui ecosystem", coinType: "0x35169bc93e1fddfcf3a82a9eae726d349689ed59e4b065369af8789fe59f8608::mmt::MMT", logoUrl: "https://statics.noodles.fi/logo/8992504305779932469.png" },
  { symbol: "HAEDAL", name: "Haedal", decimals: 9, category: "Sui ecosystem", coinType: "0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL", logoUrl: "https://statics.noodles.fi/logo/12890268452687820622" },
  { symbol: "IKA", name: "IKA Token", decimals: 9, category: "Sui ecosystem", coinType: "0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA", logoUrl: "https://statics.noodles.fi/logo/6956824444457421755.svg" },
  { symbol: "TURBOS", name: "Turbos", decimals: 9, category: "Sui ecosystem", coinType: "0x5d1f47ea69bb0de31c313d7acf89b890dbb8991ea8e03c6c355171f84bb1ba4a::turbos::TURBOS", logoUrl: "https://statics.noodles.fi/logo/10228209484758139380.jpg" },
  { symbol: "MAGMA", name: "Magma Token", decimals: 9, category: "Sui ecosystem", coinType: "0x9f854b3ad20f8161ec0886f15f4a1752bf75d22261556f14cc8d3a1c5d50e529::magma::MAGMA", logoUrl: "https://statics.noodles.fi/logo/11710130500610744212.svg" },
  { symbol: "US", name: "Talus Token", decimals: 9, category: "Sui ecosystem", coinType: "0xee962a61432231c2ede6946515beb02290cb516ad087bb06a731e922b2a5f57a::us::US", logoUrl: "https://statics.noodles.fi/logo/518008260956216517.svg" },
  { symbol: "TRUTH", name: "Swarm Network", decimals: 8, category: "Sui ecosystem", coinType: "0x0a48f85a3905cfa49a652bdb074d9e9fabad27892d54afaa5c9e0adeb7ac3cdf::swarm_network_token::SWARM_NETWORK_TOKEN", logoUrl: "https://statics.noodles.fi/logo/4420837639124659417" },
  { symbol: "TAKE", name: "TAKE", decimals: 9, category: "Sui ecosystem", coinType: "0x76a49ebaf991fa2d4cb6a352af14425d453fe2ba6802b5ed2361b227150b6689::take::TAKE", logoUrl: "https://statics.noodles.fi/logo/2434502950356612760.svg" },
  { symbol: "XMN", name: "xMoney Token", decimals: 6, category: "Sui ecosystem", coinType: "0x97c7571f4406cdd7a95f3027075ab80d3e9c937c2a567690d31e14ab1872ccee::xmn::XMN", logoUrl: "https://statics.noodles.fi/logo/8369599583659785333.jpg" },
  { symbol: "DMC", name: "DeLorean", decimals: 9, category: "Sui ecosystem", coinType: "0x4c981f3ff786cdb9e514da897ab8a953647dae2ace9679e8358eec1e3e8871ac::dmc::DMC", logoUrl: "https://statics.noodles.fi/logo/3442217361064770761.svg" },
  { symbol: "TATO", name: "Pawtato", decimals: 9, category: "Sui ecosystem", coinType: "0x04deb377c33bfced1ab81cde96918e2538fe78735777150b0064ccf7df5e1c81::tato::TATO", logoUrl: "https://statics.noodles.fi/logo/14512794130289961358.png" },
  { symbol: "haSUI", name: "haSUI", decimals: 9, category: "Liquid staking", coinType: "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI", logoUrl: "https://statics.noodles.fi/logo/6334437972931383917.svg" },
  { symbol: "vSUI", name: "Volo Staked SUI", decimals: 9, category: "Liquid staking", coinType: "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT", logoUrl: "https://statics.noodles.fi/logo/13189824273118543517.png" },
  { symbol: "afSUI", name: "afSUI", decimals: 9, category: "Liquid staking", coinType: "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI", logoUrl: "https://statics.noodles.fi/logo/16283540657745575935.svg" },
  { symbol: "stSUI", name: "AlphaFi Staked SUI", decimals: 9, category: "Liquid staking", coinType: "0xd1b72982e40348d069bb1ff701e634c117bb5f741f44dff91e472d3b01461e55::stsui::STSUI", logoUrl: "https://statics.noodles.fi/logo/15099714191308957683.png" },
  { symbol: "sSUI", name: "Spring SUI", decimals: 9, category: "Liquid staking", coinType: "0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI", logoUrl: "https://statics.noodles.fi/logo/11570756678430542905.png" },
  { symbol: "suiUSDT", name: "Tether", decimals: 6, category: "Stablecoin", coinType: SUI_USDT_COIN_TYPE, logoUrl: "https://statics.noodles.fi/logo/3350185613659011376.png" },
  { symbol: "suiUSDe", name: "eSui Dollar", decimals: 6, category: "Stablecoin", coinType: "0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE", logoUrl: "https://statics.noodles.fi/logo/14382560914482753269" },
  { symbol: "USDB", name: "Bucket USD", decimals: 6, category: "Stablecoin", coinType: "0xe14726c336e81b32328e92afc37345d159f5b550b09fa92bd43640cfdd0a0cfd::usdb::USDB", logoUrl: "https://statics.noodles.fi/logo/14137509526587240230.svg" },
  { symbol: "WBTC", name: "Wrapped BTC", decimals: 8, category: "Bitcoin", coinType: "0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC", logoUrl: "https://statics.noodles.fi/logo/3370065307328376599.svg" },
  { symbol: "suiWBTC", name: "Wrapped Bitcoin", decimals: 8, category: "Bitcoin", coinType: "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC", logoUrl: "https://statics.noodles.fi/logo/16217097113231690579.png" },
  { symbol: "xBTC", name: "OKX Wrapped BTC", decimals: 8, category: "Bitcoin", coinType: "0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC", logoUrl: "https://statics.noodles.fi/logo/6316962245976570555.png" },
  { symbol: "LBTC", name: "Lombard Staked BTC", decimals: 8, category: "Bitcoin", coinType: "0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC", logoUrl: "https://statics.noodles.fi/logo/4836990333763181976.png" },
  { symbol: "tBTC", name: "tBTC v2", decimals: 8, category: "Bitcoin", coinType: "0x77045f1b9f811a7a8fb9ebd085b5b0c55c5cb0d1520ff55f7037f89b5da9f5f1::TBTC::TBTC", logoUrl: "https://statics.noodles.fi/logo/6867657403665242147.png" },
  { symbol: "suiETH", name: "ETH by Sui Bridge", decimals: 8, category: "Ethereum", coinType: "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH", logoUrl: "https://statics.noodles.fi/logo/10536657733227645780.png" },
  { symbol: "SOL", name: "Wrapped SOL", decimals: 8, category: "Solana", coinType: "0xb7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN", logoUrl: "https://statics.noodles.fi/logo/4273538466776000573.jpeg" },
  { symbol: "XAUM", name: "Matrixdock Gold", decimals: 9, category: "Real assets", coinType: "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM", logoUrl: "https://statics.noodles.fi/logo/16420821680781671352.png" },
  { symbol: "XAGM", name: "Matrixdock Silver", decimals: 9, category: "Real assets", coinType: "0x64bddec0f898ccaa022b8a6e0a5f75d80f53177b87a9795dd15aefe9ac12ee6c::xagm::XAGM", logoUrl: "https://statics.noodles.fi/logo/17108638301008921494.png" },
  { symbol: "USDY", name: "Ondo US Dollar Yield", decimals: 6, category: "Real assets", coinType: "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY", logoUrl: "https://statics.noodles.fi/logo/11307898973982214367.svg" },
  { symbol: "HIPPO", name: "sudeng", decimals: 9, category: "Community", coinType: "0x8993129d72e733985f7f1a00396cbd055bad6f817fee36576ce483c8bbb8b87b::sudeng::SUDENG", logoUrl: "https://statics.noodles.fi/logo/12367217475693369235.png" },
  { symbol: "LOFI", name: "LOFI", decimals: 9, category: "Community", coinType: "0xf22da9a24ad027cccb5f2d496cbe91de953d363513db08a3a734d361c7c17503::LOFI::LOFI", logoUrl: "https://statics.noodles.fi/logo/3577845151260351905.png" },
  { symbol: "BLUB", name: "BLUB", decimals: 2, category: "Community", coinType: "0xfa7ac3951fdca92c5200d468d31a365eb03b2be9936fde615e69f0c1274ad3a0::BLUB::BLUB", logoUrl: "https://statics.noodles.fi/logo/4626651705687178628.jpg" },
  ...BLAST_V1_COINS,
  { symbol: "ONE", name: "JustOneSui", decimals: 6, category: "Community", coinType: "0xaaffd090b57fcdcf293f7e7ec59c119acc910eeb5fc4aadfb4185fa56b6a2cb5::suipump::SUIPUMP", logoUrl: "https://statics.noodles.fi/logo/14207055064415664154.jpeg", poolKey: "cetus:0x1f30ac740fec626467ac825121314185a9a2feacd88185d70cea7e092d07fd3a", verifiedCommunity: true },
] as const;

const byType = new Map<string, typeof CORE_COINS[number]>(CORE_COINS.map(coin => [coin.coinType, coin]));

/** Case-sensitive module/struct identity; a matching name or ticker never grants core status. */
export function coreCoin(coinType: string) {
  try { return byType.get(normalizeStructTag(coinType)); } catch { return undefined; }
}

export function blastV1Coin(coinType: string) {
  const coin = coreCoin(coinType);
  return coin?.category === "Legacy" ? coin : undefined;
}

/** These pages use a verified SUI-paired pool registered in blast-infra. */
export const INDEXED_POOL_COINS = CORE_COINS.filter((coin) => "poolKey" in coin);

/** The coin a pool page prices against. */
export type PoolQuote = Readonly<{ coinType: string; symbol: string; decimals: number }>;
export const SUI_POOL_QUOTE: PoolQuote = { coinType: SUI_COIN_TYPE, symbol: "SUI", decimals: 9 };
export const USDC_POOL_QUOTE: PoolQuote = { coinType: USDC_COIN_TYPE, symbol: "USDC", decimals: 6 };

/**
 * Majors priced in USDC from several allowlisted pools (blast-infra PR 1.3, pool report 2026-11-25):
 * Cetus USDC/SUI 0.05% and Bluefin SUI/USDC 0.175%. The first pool is the chart's; trades come from all.
 * Kept out of INDEXED_POOL_COINS, which lists the SUI-paired community pools that Home and FDV read.
 */
type MajorPoolKey = `cetus:0x${string}` | `bluefin:0x${string}`;
const MAJOR_POOL_KEYS: ReadonlyMap<string, readonly [MajorPoolKey, ...MajorPoolKey[]]> = new Map([
  [SUI_COIN_TYPE, [
    "cetus:0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab",
    "bluefin:0x15dbcac854b1fc68fc9467dbd9ab34270447aabd8cc0e04a5864d95ccb86b74a",
  ]],
]);

/** Pools with no Blast launch behind them: their chart names no V2 migration. */
const STANDALONE_POOLS: ReadonlySet<string> = new Set([...INDEXED_POOL_COINS.map((coin) => coin.poolKey), ...[...MAJOR_POOL_KEYS.values()].flat()]);
export function isStandalonePool(poolKey: string): boolean {
  return STANDALONE_POOLS.has(poolKey);
}

/** A coin whose page is a pool page: its charted pool, every pool it trades in and the quote it is priced in. */
export function indexedPoolCoin(coinType: string) {
  const coin = coreCoin(coinType);
  if (!coin) return undefined;
  const major = MAJOR_POOL_KEYS.get(coin.coinType);
  if (major) return { ...coin, poolKey: major[0], poolKeys: major, quote: USDC_POOL_QUOTE, major: true as const };
  return "poolKey" in coin ? { ...coin, poolKeys: [coin.poolKey] as const, quote: SUI_POOL_QUOTE, major: false as const } : undefined;
}

/**
 * A coin's shown symbol and name. A curated ticker that replaces the indexed one (hBTC → hashiBTC)
 * brings its curated name too, so hashiBTC never pairs with the indexed name "BTC".
 * Blast V1 coins always use the catalog name for their exact types.
 */
export function curatedIdentity(coinType: string, symbol: string, name: string): { symbol: string; name: string } {
  const core = coreCoin(coinType);
  return core && (core.symbol !== symbol || core.category === "Legacy") ? { symbol: core.symbol, name: core.name } : { symbol, name };
}

/** Preferred identities break equal-value ties in coin lists. */
// USDsui decimals: https://www.docs.sui.io/onchain-finance/deepbook/deepbookv3/contract-information
export const PREFERRED_COINS = [coreBySymbol("SUI"), coreBySymbol("USDC"), coreBySymbol("USDsui")] as const;

/** By symbol, not position: the curated order is free to change. */
function coreBySymbol<Name extends (typeof CORE_COINS)[number]["symbol"]>(symbol: Name) {
  return CORE_COINS.find((coin): coin is Extract<(typeof CORE_COINS)[number], { symbol: Name }> => coin.symbol === symbol)!;
}

export function coinPriority(coinType: string): number {
  const coin = coreCoin(coinType);
  if (!coin) return PREFERRED_COINS.length + 1;
  const index = PREFERRED_COINS.findIndex(preferred => preferred.coinType === coin.coinType);
  return index < 0 ? PREFERRED_COINS.length : index;
}
