import { z } from "zod";

import { CARD_EDITIONS, cardEditionForCrew, type CardEdition } from "../../mission-control/card-renderer/editions.ts";
import { isSocialCallsign } from "./accounts.ts";

/** Public card identity; unpublished artwork and private image URLs are never exposed. */
export type CardIdentity = Readonly<{ crew: number; edition: CardEdition; published_card_id: string | null }>;
export const CARD_IDENTITY_BATCH_SIZE = 50;
export const CARD_IDENTITY_PATH = "/api/social/card-identities";
export const OWNER_CARD_PATH = "/api/social/me/card";
export const cardIdentityKey = (callsign: string) => ["social", "card-identity", callsign] as const;

export const cardIdentitySchema = z.object({
  crew: z.number().int().min(1).max(999999),
  edition: z.enum(CARD_EDITIONS),
  published_card_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).nullable(),
}).refine(({ crew, edition }) => edition === cardEditionForCrew(crew), { when: ({ issues }) => issues.length === 0 });

export function isCardIdentity(value: unknown): value is CardIdentity {
  return cardIdentitySchema.safeParse(value).success;
}

export function cardIdentityCallsigns(url: URL): string[] | null {
  const values = url.searchParams.getAll("callsigns");
  const callsigns = values.length === 1 ? values[0]!.split(",") : [];
  return z.array(z.string().refine(isSocialCallsign)).min(1).max(CARD_IDENTITY_BATCH_SIZE).safeParse(callsigns).success
    ? [...new Set(callsigns)].sort() : null;
}

export const cardRingPath = (edition: CardEdition) => `/social/card-rings/${edition}.svg`;
