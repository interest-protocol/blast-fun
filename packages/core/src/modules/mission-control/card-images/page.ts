export const CARD_PAGE_MAX_BYTES = 16 * 1024;

export type CardPage = Readonly<{
  cardId: string;
  callsign: string;
  crew: number;
  recruitTotal: number;
}>;

function validIdentity(
  card: Record<string, unknown>,
  expectedId: string,
): boolean {
  return (
    typeof card.cardId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      card.cardId,
    ) &&
    card.cardId === expectedId.toLowerCase() &&
    typeof card.callsign === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,19}$/.test(card.callsign)
  );
}

function validCounts(card: Record<string, unknown>): boolean {
  return (
    typeof card.crew === "number" &&
    Number.isSafeInteger(card.crew) &&
    card.crew >= 1 &&
    card.crew <= 999999 &&
    typeof card.recruitTotal === "number" &&
    Number.isSafeInteger(card.recruitTotal) &&
    card.recruitTotal >= 0
  );
}

export function parseCardPage(
  text: string,
  expectedId: string,
): CardPage | null {
  if (new TextEncoder().encode(text).byteLength > CARD_PAGE_MAX_BYTES) {
    throw new Error("Card page unavailable");
  }
  const value: unknown = JSON.parse(text);
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Card page unavailable");
  }
  const card = value as Record<string, unknown>;
  const keys = Object.keys(card).sort().join(",");
  if (
    keys !== "callsign,cardId,crew,recruitTotal" ||
    !validIdentity(card, expectedId) ||
    !validCounts(card)
  ) {
    throw new Error("Card page unavailable");
  }
  return card as CardPage;
}
