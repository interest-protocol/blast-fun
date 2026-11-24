export type DiscoveryPreferences = Readonly<{
  source: "following" | "recent";
  buy: boolean;
  sell: boolean;
  presale: boolean;
}>;

export const DEFAULT_DISCOVERY: DiscoveryPreferences = {
  source: "following",
  buy: true,
  sell: true,
  presale: true,
};

export function discoveryPreferences(raw: string | null): DiscoveryPreferences {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || (value.source !== "following" && value.source !== "recent"))
      return DEFAULT_DISCOVERY;
    return {
      source: value.source,
      buy: typeof value.buy === "boolean" ? value.buy : true,
      sell: typeof value.sell === "boolean" ? value.sell : true,
      presale: typeof value.presale === "boolean" ? value.presale : true,
    };
  } catch {
    return DEFAULT_DISCOVERY;
  }
}

export function discoveryKindVisible(
  kind: string,
  preferences: DiscoveryPreferences,
) {
  if (kind === "trade_buy") return preferences.buy;
  if (kind === "trade_sell") return preferences.sell;
  return preferences.presale;
}
