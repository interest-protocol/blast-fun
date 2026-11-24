import { liveFreshness } from "#web/components/social/home/activity-hints.ts";

export function presaleFreshness(surface: string, pollMs: number, presaleId: string, coinType: string | null | undefined) {
  return liveFreshness(surface, pollMs, (hint) =>
    hint.cause !== "hint" || hint.trade?.presaleId === presaleId ||
      (coinType != null && hint.trade?.coinType === coinType),
  );
}
