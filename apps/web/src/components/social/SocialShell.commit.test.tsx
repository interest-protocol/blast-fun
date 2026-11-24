import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { toast as sonner } from "sonner";

import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ALON_READ } from "../../../test/fixtures/social/commit/alon.ts";
import type { CommitFacts, CommitKit } from "./commit/commit-kit";
import { commitSaleOf, commitViewerOf } from "./commit/commit-view";
import { useCommitKit } from "./feed-ui/shell-bridge";
import { SocialViewerProvider } from "./SignInGate";
import { SocialAccountContext } from "./use-social-account";

// Replace only transaction execution; the shell, commit host and toast wiring are real.
const execution = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/social/commit/commit-run.ts")) return {
      format: "module",
      shortCircuit: true,
      source: `export async function runCommitFor(input) {
        return input.blockers.length
          ? { status: "failed", message: "Nothing was sent.", digest: null }
          : { status: "sent", amount: input.input.quoteAtoms, digest: input.input.quoteAtoms === "1000000000000" ? "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKj" : "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" };
      }`,
    };
    return nextLoad(url, context);
  },
});
const { SocialShell } = await import("./SocialShell");

test("a homepage presale purchase confirms success through the real shell host, with one notification region", async (t) => {
  t.after(() => execution.deregister());
  let kit: CommitKit | null = null;
  function Purchase() { kit = useCommitKit(); return <p>Presale purchase</p>; }
  const router = { push() {}, replace() {}, prefetch() {} } as unknown as AppRouterInstance;
  const html = renderToStaticMarkup(
    <AppRouterContext value={router}>
      <PathnameContext value="/">
        <SocialAccountContext value={{ status: "signed_out", account: null, refresh() {} }}>
          <SocialViewerProvider signedIn callsign="kai">
            <SocialShell presaleDeployed><Purchase /></SocialShell>
          </SocialViewerProvider>
        </SocialAccountContext>
      </PathnameContext>
    </AppRouterContext>,
  );
  assert.equal([...html.matchAll(/aria-label="Notifications"[^>]*aria-live="polite"/g)].length, 1);
  assert.ok(kit);
  const host: CommitKit = kit;
  t.after(() => host.quotes.dispose());
  const sale = commitSaleOf(ALON_READ, { suiUsd: null });
  assert.ok(sale);
  const facts: CommitFacts = {
    detail: ALON_READ, sale, viewer: commitViewerOf({ sale, wallet: null, entry: null, allowlist: null }), blockers: [], proof: null,
    wallet: { address: `0x${"a".repeat(64)}`, signer: "wallet", fee: "wallet", coins: [], as_of_ms: 0 },
  };
  const input = { payWith: "TSUI", pay: 10, quote: 10, usd: 0, why: "", quoteAtoms: "10000000000", paymentSymbol: "TSUI" };
  const before = sonner.getToasts().length;
  const sent = await host.send(facts, input);
  assert.equal(sent.status, "sent");
  assert.equal(sonner.getToasts().length, before + 1, "the successful purchase must show a toast");
  const toast = sonner.getToasts().at(-1)!;
  assert.ok("jsx" in toast);
  const message = renderToStaticMarkup(toast.jsx);
  assert.match(message, /Contribution confirmed/);
  assert.match(message, /10 TSUI.*ALON/);
  assert.match(message, /href="https:\/\/suiscan.xyz\/mainnet\/tx\/4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"/);
  assert.equal(toast.duration, 7000);
  let confirmed = false;
  await host.send(facts, { ...input, pay: 1000, quote: 1000, quoteAtoms: "1000000000000" }, {
    onConfirmed(receipt) {
      confirmed = true;
      assert.equal(receipt.amount, "1,000");
      assert.equal(receipt.currency, "TSUI");
      assert.equal(receipt.symbol, "ALON");
    },
  });
  assert.equal(confirmed, true, "a visible purchase receives its persistent receipt");
  assert.equal(sonner.getToasts().length, before + 2, "each confirmed purchase shows one toast");
  const refused = await host.send({ ...facts, blockers: ["presale_not_deployed"] }, input);
  assert.equal(refused.status, "refused");
  assert.equal(sonner.getToasts().length, before + 2, "a refusal must not show success");
});
