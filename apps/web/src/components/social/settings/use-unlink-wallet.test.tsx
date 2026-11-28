import assert from "node:assert/strict";
import test from "node:test";

import type { SocialAccountWallet, SocialMeAccount } from "@blast/core/web/contracts/me.ts";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SocialViewerProvider } = await import("../SignInGate.tsx");
const { useUnlinkWallet } = await import("./use-unlink-wallet.ts");

const wallet: SocialAccountWallet = { address: `0x${"ab".repeat(32)}`, kind: "slush", linked_at_ms: 1 };
const account: SocialMeAccount = {
  account_id: "00000000-0000-4000-8000-000000000001",
  kind: "new",
  callsign: "first",
  display_name: null,
  avatar_url: null,
  x_handle: null,
  verified: false,
  onboarding: { shown: true, completed: true },
  privacy: "public",
  sharing_since_ms: null,
  wallets: [wallet],
};

test("a pending Slush unlink cannot sign out an account that took over the session", async (t) => {
  let answer!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(input, "/api/social/me/wallets");
    assert.equal(init?.method, "DELETE");
    return new Promise<Response>((resolve) => { answer = resolve; });
  });
  const root = createRoot(document.createElement("div"));
  t.after(async () => { await act(async () => { root.unmount(); }); });

  let signOuts = 0;
  let unlink!: ReturnType<typeof useUnlinkWallet>;
  function Probe({ owner }: { owner: SocialMeAccount }) {
    unlink = useUnlinkWallet({
      account: owner,
      getTokenSource: () => async () => "viewer-token",
      refresh: () => undefined,
      signOut: async () => { signOuts += 1; },
    });
    return null;
  }
  function show(owner: SocialMeAccount) {
    root.render(
      <SocialViewerProvider signedIn sessionPending accountId={owner.account_id} sessionIdentity={owner.callsign}>
        <Probe owner={owner} />
      </SocialViewerProvider>,
    );
  }

  await act(async () => { show(account); });
  await act(async () => { unlink.open(wallet); });
  let confirmed!: Promise<string | null>;
  await act(async () => { confirmed = unlink.confirm(); });
  assert.equal(typeof answer, "function", "the unlink request is in flight");
  await act(async () => { show({ ...account, account_id: "00000000-0000-4000-8000-000000000002", callsign: "second" }); });
  await act(async () => {
    answer(Response.json({ account_deleted: true, signed_out: true }));
    assert.equal(await confirmed, null);
  });
  assert.equal(signOuts, 0);
});
