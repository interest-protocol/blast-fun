import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import type { SocialMeAccount } from "@blast/core/modules/social/contracts/me.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { SocialShell } from "./SocialShell";
import { SocialViewerProvider } from "./SignInGate";
import { SocialAccountContext } from "./use-social-account";

const account: SocialMeAccount = {
  account_id: "kai", kind: "new", callsign: "kai", display_name: null, avatar_url: null, x_handle: null,
  verified: false, onboarding: { shown: true, completed: true }, privacy: "private", sharing_since_ms: null,
  wallets: [],
};
const router = { push() {}, replace() {}, prefetch() {} } as unknown as AppRouterInstance;

test("claimable holdings leave the signed-in and visitor Home shells unchanged", () => {
  const client = createTestQueryClient();
  const render = (signedIn = true) => renderToStaticMarkup(withQueryClient(client,
    <AppRouterContext value={router}>
      <PathnameContext value="/">
        <SocialAccountContext value={{ status: "ready", account, refresh() {} }}>
          <SocialViewerProvider signedIn={signedIn} callsign="kai" getAccessToken={async () => "test"}>
            <SocialShell><h1>Home</h1></SocialShell>
          </SocialViewerProvider>
        </SocialAccountContext>
      </PathnameContext>
    </AppRouterContext>,
  ));
  client.setQueryData(queryKeys.me.notifications.unread(), { unread_count: 0 });
  const signedIn = render();
  const visitor = render(false);
  const holdings = { created: [], positions: [], watchlist: [], coins: [], vestings: [] };

  client.setQueryData(queryKeys.me.presales(), holdings);
  assert.equal(render(), signedIn);

  client.setQueryData(queryKeys.me.presales(), { ...holdings, vestings: [{ claimable: "0.000000001" }] });
  assert.equal(render(), signedIn);

  client.setQueryData(queryKeys.me.presales(), { ...holdings, vestings: [{ claimable: "1" }, { claimable: "100" }] });
  assert.equal(render(), signedIn);
  assert.equal(render(false), visitor);
  client.clear();
});
