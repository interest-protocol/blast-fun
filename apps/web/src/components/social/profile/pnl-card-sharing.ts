import { PNL_CARD_SHARE_PATH, pnlCardShareSchema } from "@blast/core/web/contracts/pnl-card-sharing.ts";
import { ownerCardShareIntent } from "#web/components/mission-control/owner-card-actions.ts";
import { callSocialApi, type SocialApiOptions } from "#web/components/social/social-api.ts";

export function publishPnlCard(file: File, options: SocialApiOptions) {
  return callSocialApi(options, PNL_CARD_SHARE_PATH, { method: "POST", raw: file }, pnlCardShareSchema);
}

export async function sharePnlCardOnX(file: File, options: SocialApiOptions, controller: AbortController): Promise<string> {
  // Open on the click, before uploading, so the composer is not popup-blocked.
  let popup: Window | null = null;
  try {
    popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    controller.signal.addEventListener("abort", () => popup?.close(), { once: true });
    const result = await publishPnlCard(file, {
      ...options,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    if (controller.signal.aborted) return "";
    if (result.status !== "ok") throw new Error("Card link unavailable.");
    const intent = ownerCardShareIntent(new URL(result.body.path, window.location.origin).href);
    if (popup) {
      if (popup.closed) return "";
      popup.location.href = intent;
    } else window.location.assign(intent);
    return "X composer opened. Review your post and press Post.";
  } catch {
    popup?.close();
    return controller.signal.aborted ? "" : "Card link could not be prepared. Try again or download the PNG.";
  }
}
