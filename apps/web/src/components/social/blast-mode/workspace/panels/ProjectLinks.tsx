"use client";

import { queryKeys } from "#web/lib/query/keys.ts";
import { useQuery } from "@tanstack/react-query";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { LinkIcon, TelegramIcon, XMark } from "#web/components/presale-pages/icons.tsx";
import type { SocialSaleMetadata } from "@blast/core/web/contracts/sales.ts";
import type { CoinAsset, CoinReads } from "./coin-reads";
import styles from "./PanelChrome.module.css";

export type ProjectMetadata = Pick<SocialSaleMetadata, "site" | "x_handle" | "telegram">;

/** Public, canonical asset metadata; failures never block price or wallet reads. */
export function CoinProjectLinks({ asset, reads, visible }: Readonly<{ asset: CoinAsset; reads: CoinReads; visible: boolean }>) {
  const query = useQuery({
    queryKey: queryKeys.projectLinks(asset.network, asset.coin_type, asset.presale_id),
    queryFn: ({ signal }) => reads.links?.(asset, signal) ?? Promise.resolve(null),
    enabled: visible && asset.network === "mainnet" && !!reads.links,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    retry: false,
  }, useAppQueryClient());
  return <ProjectLinks metadata={query.data} />;
}

export function ProjectLinks({ metadata }: Readonly<{ metadata?: ProjectMetadata | null }>) {
  const links = [
    { label: "Project website", href: website(metadata?.site), icon: <LinkIcon /> },
    { label: "Project on X", href: metadata?.x_handle && /^[A-Za-z0-9_]{1,15}$/.test(metadata.x_handle) ? `https://x.com/${metadata.x_handle}` : null, icon: <XMark /> },
    { label: "Project on Telegram", href: metadata?.telegram && /^[A-Za-z0-9_]{5,32}$/.test(metadata.telegram) ? `https://t.me/${metadata.telegram}` : null, icon: <TelegramIcon /> },
  ].filter(link => link.href);
  if (!links.length) return null;
  return <nav className={styles.socials} aria-label="Project links">{links.map(link => <a key={link.label} href={link.href!} aria-label={`${link.label} (opens in a new tab)`} title={link.label} target="_blank" rel="nofollow noopener noreferrer">{link.icon}</a>)}</nav>;
}

function website(value?: string | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; } catch { return null; }
}
