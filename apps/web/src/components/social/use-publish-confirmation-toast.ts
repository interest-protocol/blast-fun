import { useCallback, useRef } from "react";

import { explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { useCaptureViewerScope } from "./SignInGate";

const titles = {
  publish_coin: "Coin published",
  register_currency: "Currency registered",
  create_launch: "Launch confirmed",
  create_presale: "Presale created",
} as const;

/** Capture the creator so an in-flight step can confirm after leaving the page. */
export function usePublishConfirmationToast() {
  const captureViewer = useCaptureViewerScope();
  const toast = useToast();
  const { explorer } = useDevicePrefs();
  const seen = useRef(new Set<string>());

  return useCallback(() => {
    const sameViewer = captureViewer();
    return (step: keyof typeof titles, digest: string) => {
      if (!sameViewer() || seen.current.has(digest)) return;
      seen.current.add(digest);
      try {
        toast(titles[step], { href: explorerTransactionUrl(explorer, digest) ?? undefined, id: `publish:${digest}` });
      } catch {
        // Feedback cannot interrupt publishing after the step has confirmed.
      }
    };
  }, [captureViewer, explorer, toast]);
}

export type PublishConfirmation = ReturnType<ReturnType<typeof usePublishConfirmationToast>>;
