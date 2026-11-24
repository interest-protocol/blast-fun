import type {
  SocialPresaleDetail,
  SocialPresaleViewerEntry,
  PresalePhase,
} from "@blast/core/modules/social/contracts/presales.ts";
import type { CommitFacts } from "../../../src/components/social/commit/commit-kit.ts";
import { commitSaleOf } from "../../../src/components/social/commit/commit-view.ts";
import { fixtureWallet } from "../social/trade/trade-fixtures.ts";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

export const presaleId = `0x${"4".repeat(64)}`;
export const presaleCoin = `0x${"5".repeat(64)}::kestrel::KSTL`;
export const presaleAsset = {
  chain: "sui",
  network: "mainnet",
  coin_type: presaleCoin,
  presale_id: presaleId,
} as const;
export function presaleDetail(
  phase: PresalePhase = "open",
): SocialPresaleDetail {
  const now = Date.now();
  const momentum = {
    commits: 1,
    total_usd: "123.450001",
    total_atoms: "123450001",
    backers: 1,
    average_usd: "123.450001",
    median_usd: "123.450001",
    average_atoms: "123450001",
    median_atoms: "123450001",
    big_bps: 0,
  };
  return {
    creator: null,
    presale: {
      presale_id: presaleId,
      sale_token: presaleCoin,
      name: "Kestrel",
      symbol: "KSTL",
      icon_url: "",
      phase,
      venue: "cetus",
      start_ms: now - 3600000,
      end_ms: now + 86400000,
      ended_ms: null,
      launched_ms: null,
      target_usd: "10000",
      raised_usd: "123.450001",
      quote_symbol: "USDC",
      quote_type: USDC_COIN_TYPE,
      quote_decimals: 6,
      sale_decimals: 9,
      target_atoms: "10000000000",
      raised_atoms: "123450001",
      fill_bps: 123,
      participants: 1,
      allowlisted: false,
      interested: 2,
      presale_price_usd: "0.000111111111111111",
      presale_price_quote: "0.000111111111111111",
      price_usd: null,
      multiple: null,
      verified_team: false,
      audited: false,
      metadata: null,
      min_commitment_usd: "10",
      wallet_cap_usd: "5000",
      min_commitment_atoms: "10000000",
      wallet_cap_atoms: "5000000000",
      opened_ms: now - 3600000,
    },
    quote_price: null,
    momentum: {
      "5m": momentum,
      "1h": momentum,
      "4h": momentum,
      "1d": momentum,
    },
    backers: {
      top: [
        {
          wallet: `0x${"6".repeat(64)}`,
          account: null,
          commitment_usd: "123.450001",
          commitment_atoms: "123450001",
          share_bps: 10000,
          last_commit_ms: now - 1000,
          why: "Building something useful",
        },
      ],
      top10_bps: 10000,
    },
    theses: [],
    activity: [],
    raise: {
      points: [[now - 1000, "123.450001", "123450001"]],
      markers: [
        {
          t: now - 1000,
          raised_usd: "123.450001",
          commit_usd: "123.450001",
          raised_atoms: "123450001",
          commit_atoms: "123450001",
          wallet: `0x${"6".repeat(64)}`,
          account: null,
          why: null,
        },
      ],
    },
    vesting: {
      start_ms: now + 86400000,
      cliff_end_ms: now + 172800000,
      end_ms: now + 259200000,
    },
    team_vesting: null,
    terms: {
      supply: {
        total: "1000000000000000000",
        participants: { bps: 5000, amount: "500000000000000000" },
        liquidity: { bps: 2000, amount: "200000000000000000" },
        recipients: [
          {
            address: `0x${"7".repeat(64)}`,
            bps: 3000,
            amount: "300000000000000000",
            vesting: {
              start_ms: now + 86400000,
              cliff_end_ms: now + 172800000,
              end_ms: now + 259200000,
            },
          },
        ],
        protocol: { bps: 0, amount: "0" },
      },
      raise: {
        pool_bps: 10000,
        recipients: [],
        protocol: { bps: 0, amount: "0" },
      },
      eligibility: { kind: "open" },
      presale_price_usd: "0.000111111111111111",
      launch_price_usd: "0.000222222222222222",
      presale_price_quote: "0.000111111111111111",
      launch_price_quote: "0.000222222222222222",
      burnable: false,
      hard_cap: false,
    },
    as_of: { checkpoint: 123, timestamp_ms: now - 1000, lag_ms: 1000 },
  };
}
export function presaleFacts(detail = presaleDetail()): CommitFacts {
  return {
    detail,
    sale: commitSaleOf(detail, { suiUsd: 2 }),
    viewer: { usdc: 860, sui: 50, suiUsd: 2, committed: 0, allowlist: null },
    blockers: [],
    proof: null,
    wallet: fixtureWallet(),
  };
}
export const presaleViewer: SocialPresaleViewerEntry = {
  following: [],
  following_total_usd: "0",
  following_total_atoms: "0",
  mine: {
    commitment_usd: "123.450001",
    commitment_atoms: "123450001",
    commits: [],
    claimed: false,
    refund_usd: "123.450001",
    refund_atoms: "123450001",
    claimable_tokens: "123450001000",
  },
};
