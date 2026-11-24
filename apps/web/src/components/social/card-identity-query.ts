"use client";

import { useQuery } from "@tanstack/react-query";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { PublicError, responseError, responseDiagnostic } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { isSocialCallsign } from "@blast/core/web/contracts/accounts.ts";
import { CARD_IDENTITY_BATCH_SIZE, CARD_IDENTITY_PATH, cardIdentityKey, isCardIdentity, type CardIdentity } from "@blast/core/web/contracts/card-identity.ts";

type Pending = { callsign: string; resolve: (identity: CardIdentity | null) => void; reject: (error: unknown) => void };

/** Coalesce avatars mounted together into bounded reads; React Query deduplicates repeated identities. */
export function createCardIdentityLoader(request: typeof fetch = gatedFetch) {
  const pending: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function flush() {
    const batch = pending.splice(0, CARD_IDENTITY_BATCH_SIZE);
    timer = pending.length ? setTimeout(() => void flush(), 0) : undefined;
    const callsigns = [...new Set(batch.map(({ callsign }) => callsign))].sort();
    try {
      const response = await request(`${CARD_IDENTITY_PATH}?callsigns=${encodeURIComponent(callsigns.join(","))}`, {
        credentials: "omit", signal: AbortSignal.timeout(15000),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw responseError(body, response);
      if (!body || typeof body !== "object") throw new PublicError("Card identities could not load. Try again.", { ...responseDiagnostic(response), code: "invalid_response" });
      for (const callsign of callsigns) {
        if (!(callsign in body) || (Reflect.get(body, callsign) !== null && !isCardIdentity(Reflect.get(body, callsign)))) throw new PublicError("Card identity could not load. Try again.", { ...responseDiagnostic(response), code: "invalid_response" });
      }
      for (const item of batch) item.resolve(Reflect.get(body, item.callsign));
    } catch (error) {
      for (const item of batch) item.reject(error);
    }
  }
  return (callsign: string): Promise<CardIdentity | null> => new Promise((resolve, reject) => {
    pending.push({ callsign, resolve, reject });
    timer ??= setTimeout(() => void flush(), 0);
  });
}

const load = createCardIdentityLoader();

export function useCardIdentityQuery(callsign: string) {
  const client = useAppQueryClient();
  return useQuery({
    queryKey: cardIdentityKey(callsign), queryFn: () => load(callsign),
    enabled: isSocialCallsign(callsign), staleTime: 60000,
  }, client);
}

export function useCardIdentity(callsign: string): CardIdentity | null {
  return useCardIdentityQuery(callsign).data ?? null;
}
