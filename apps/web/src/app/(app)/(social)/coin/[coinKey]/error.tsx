"use client";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";

export default function CoinError({ reset }: Readonly<{ reset: () => void }>) {
  return <EmptyState framed role="alert" title="Coin couldn't load" action={<Button onClick={reset}>Try again</Button>}>Check your connection and try again.</EmptyState>;
}
