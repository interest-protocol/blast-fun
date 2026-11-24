"use client";

import { useState } from "react";
import { AppShell } from "#web/components/blast-ui/AppShell.tsx";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { Pick } from "#web/components/social/coin-home/HomeControls.tsx";
import { PaymentCoinSelector } from "#web/components/social/commit/PaymentCoinSelector.tsx";
import { SelectField } from "#web/components/blast-ui/TextField.tsx";
import { DisclosureSummary } from "#web/components/blast-ui/Button.tsx";
import { FIXTURE_COINS } from "../../../social/coins/coins-fixture-model.ts";

const coin = { ...FIXTURE_COINS[0]!, key: "long-payment", coinType: "0x2::long::LONG", symbol: "LONG", iconUrl: null, name: "A very long payment coin name ".repeat(12) };

/** Real adapters with bounded synthetic data: catches wrapper/slot regressions. */
export default function ChevronProof() {
  const [value, setValue] = useState("24h");
  return <QueryProvider><div data-blast-ui="" data-theme="light">
    <AppShell home signedIn viewer={{ accountId: "chevron-proof", callsign: "trader", displayName: "A very long account display name", avatarUrl: null, verified: false }} portfolio={{ status: "ready", summary: { total_usd: 4760.12, today: null, breakdown: { coins: 4000, committed: 760.12, claimable: 0 } } }} signInHref="/sign-in">
      <main style={{ maxWidth: 660, padding: 16, display: "grid", gap: 20 }}>
        <h1>Chevron adapters</h1>
        <Pick label="Activity window" value={value} options={["1h", "24h"]} labels={{ "1h": "1h", "24h": "24h" }} onPick={setValue} />
        <label>Compact native select<SelectField size="sm" aria-label="Compact select"><option>0.5%</option><option>1%</option></SelectField></label>
        <PaymentCoinSelector accepted={coin} selected={coin} coins={[]} busy={false} purchase onPick={() => undefined} />
        <PaymentCoinSelector accepted={coin} selected={coin} coins={[]} busy={false} purchase={false} onPick={() => undefined} />
        <details><DisclosureSummary>Presale history</DisclosureSummary><p>History details</p></details>
      </main>
    </AppShell>
  </div></QueryProvider>;
}
