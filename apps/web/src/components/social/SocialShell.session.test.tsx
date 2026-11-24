import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { SocialShell } from "./SocialShell";
import { SocialViewerProvider } from "./SignInGate";
import { SocialAccountContext } from "./use-social-account";

const router = { bfcacheId: "test", push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const viewer = { accountId: "pilot", callsign: "pilot", displayName: "Pilot", avatarUrl: null, verified: false };

test("the real social shell server-renders a verified account while its client session remains pending", () => {
  const client = createTestQueryClient();
  try {
    const html = renderToStaticMarkup(withQueryClient(client,
      <AppRouterContext value={router}><PathnameContext value="/presale/test">
        <SocialAccountContext value={{ status: "loading", account: null, refresh() {} }}>
          <SocialViewerProvider signedIn={false} sessionPending callsign={null}>
            <SocialShell initialSession={{ signedIn: true, viewer, viewerLoading: false, viewerError: false }}><p>Presale</p></SocialShell>
          </SocialViewerProvider>
        </SocialAccountContext>
      </PathnameContext></AppRouterContext>,
    ));
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    assert.match(header, />Fund<\/button>/);
    assert.match(header, /Account menu/);
    assert.match(header, /Portfolio value, Loading…/);
    assert.doesNotMatch(header, /Sign in|accountPlaceholder|Unavailable|\$0\.00/);
  } finally {
    client.clear();
  }
});
