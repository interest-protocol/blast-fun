import { normalizeStructTag } from "@mysten/sui/utils";
import {
  socialPresalePath,
  type SocialPresaleDetail,
  type SocialPresaleViewerEntry,
} from "@blast/core/web/contracts/presales.ts";
import { fetchPresaleViewer } from "#web/components/presale-pages/presales-client.ts";
import type { SocialApiOptions } from "#web/components/social/social-api.ts";
import { fetchHomeDiscussion } from "#web/components/social/coin-home/home-client.ts";
import type { CoinReads } from "./coin-reads";
import type { CoinAsset } from "./coin-reads";

export type PresaleAsset = CoinAsset;
export type PresaleReads = Pick<CoinReads, "posts"> & Readonly<{
  detail: (
    asset: PresaleAsset,
    signal: AbortSignal,
  ) => Promise<SocialPresaleDetail | null>;
  viewer: (
    asset: PresaleAsset,
    signal: AbortSignal,
  ) => Promise<SocialPresaleViewerEntry | null>;
}>;

/** Existing public detail and actor-scoped viewer routes; no polling or lifecycle inference. */
export function createPresaleReads(
  getAccessToken: SocialApiOptions["getAccessToken"] = async () => null,
): PresaleReads {
  return {
    posts: (asset, cursor, signal) => asset.network === "mainnet" && asset.presale_id ? fetchHomeDiscussion(asset.presale_id, cursor, signal) : Promise.resolve(null),
    async detail(asset, signal) {
      if (asset.network !== "mainnet" || !asset.presale_id) return null;
      const response = await fetch(socialPresalePath(asset.presale_id), {
        credentials: "same-origin",
        signal,
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Presale read unavailable");
      const body = (await response.json()) as SocialPresaleDetail | null;
      if (
        !body?.presale ||
        body.presale.presale_id !== asset.presale_id ||
        !body.presale.sale_token
      )
        return null;
      if (
        normalizeStructTag(body.presale.sale_token) !==
        normalizeStructTag(asset.coin_type)
      )
        return null;
      // Partial metadata keeps the tracked record; absent public sections are shown as unavailable.
      return body;
    },
    async viewer(asset, signal) {
      if (asset.network !== "mainnet" || !asset.presale_id) return null;
      const result = await fetchPresaleViewer(
        { getAccessToken, signal },
        { presale_ids: [asset.presale_id] },
      );
      if (!result) throw new Error("Position read unavailable");
      return result.presales[asset.presale_id] ?? null;
    },
  };
}
