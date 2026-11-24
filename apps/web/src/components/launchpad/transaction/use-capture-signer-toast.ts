import { useCallback, useLayoutEffect, useRef } from "react";

import { useToast, type ToastOptions } from "#web/components/blast-ui/Toasts.tsx";
import { useCaptureViewerScope } from "#web/components/social/SignInGate.tsx";
import type { SignerSummary } from "./action-machine";
import type { SignerSource } from "./controller";

/** Bind a confirmation to its signing viewer and wallet while the shell stays open. */
export function useCaptureSignerToast(signers: SignerSource) {
  const captureViewer = useCaptureViewerScope();
  const toast = useToast();
  const attached = useRef(false);
  useLayoutEffect(() => {
    attached.current = true;
    return () => { attached.current = false; };
  }, []);

  return useCallback((owner: SignerSummary) => {
    const sameViewer = captureViewer();
    const connected = signers.current();
    return (title: string, options: ToastOptions): boolean => {
      if (!sameViewer() || connected?.isConnectedAccount?.() === false) return false;
      if (attached.current) {
        const current = signers.current();
        if (current?.address !== owner.address || current?.chain !== owner.chain || current?.kind !== owner.kind) return false;
      }
      try {
        toast(title, options);
        return true;
      } catch {
        return false;
      }
    };
  }, [captureViewer, signers, toast]);
}
