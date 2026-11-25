"use client";

import { skipToken, useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";
import { allowlistLeafQuery, walletQuery } from "#web/components/social/queries.ts";
import { useSignInGate, useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import { PublicError } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { NO_ACCESS_TOKEN } from "./presales-client";
import { saleAccess, type SaleAccess, type SaleAccessReads } from "./sale-access";

function accessWallet(wallet: Pick<UseQueryResult, "status" | "error">, address: string | null): SaleAccessReads["wallet"] {
  if (wallet.status === "pending") return undefined;
  if (address !== null) return address;
  if (wallet.status === "success") return { failed: "wallet_missing" };
  return { failed: wallet.error instanceof PublicError ? wallet.error.code : null };
}

/**
 * The viewer's access to an upcoming whitelisted sale: their Blast wallet (the
 * shared `/me/wallet` read the commit flow uses) and its allowlist leaf (the
 * shared proof query), each read once per session. A public sale, or a
 * signed-out viewer, reads nothing.
 */
export function useSaleAccess(detail: SocialPresaleDetail): Readonly<{ access: SaleAccess; retry: () => void; retrying: boolean }> {
  const gate = useSignInGate();
  const { getAccessToken } = useSocialViewer();
  const hydrated = useHydrated();
  const queries = useAppQueryClient();
  const sale = detail.presale;
  const token = getAccessToken ?? NO_ACCESS_TOKEN;
  const viewer = !hydrated || gate.sessionPending ? "pending" : gate.signedIn ? "signed_in" : "signed_out";
  const asks = sale.allowlisted && viewer === "signed_in";
  const wallet = useQuery({ ...walletQuery(token), enabled: asks }, queries);
  const address = wallet.data?.address ?? null;
  const leafRead = allowlistLeafQuery(token, sale.presale_id, address ?? "");
  // No address, no proof read: skipToken also keeps a manual refetch from asking for an empty wallet.
  const leaf = useQuery({ ...leafRead, queryFn: asks && address !== null ? leafRead.queryFn : skipToken }, queries);
  const access = saleAccess(detail, {
    viewer,
    wallet: accessWallet(wallet, address),
    leaf: leaf.isError ? { status: "error" } : leaf.data,
  });
  // Ask again whichever read the answer is missing: the wallet when there is no address, else its proof.
  const retry = () => void (address === null ? wallet.refetch() : leaf.refetch());
  return { access, retry, retrying: wallet.isFetching || leaf.isFetching };
}
