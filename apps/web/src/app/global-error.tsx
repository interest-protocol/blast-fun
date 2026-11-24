"use client";

import "./globals.css";
import "#web/components/blast-ui/blast-ui.css";
import { ErrorFallback } from "#web/components/ErrorFallback.tsx";

export default function GlobalError(props: Readonly<{ error: Error & { digest?: string }; retry: () => void }>) {
  return <html lang="en"><body><ErrorFallback {...props} /></body></html>;
}
