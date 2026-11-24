import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { cardIdentityKey } from "@blast/core/modules/social/contracts/card-identity.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { hydrateRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { renderToString } = await import("react-dom/server");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { ProfileView } = await import("../ProfileView");
const { SocialViewerProvider } = await import("../SignInGate");
const { SocialAccountContext } = await import("../use-social-account");

const profile = { callsign: "kai", display_name: "Kai", avatar_url: null, x_handle: null, verified: false, private: false, portfolio_public: true };
const router = { bfcacheId: "hydration-test", push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };

test("session restoration goes from the shared skeleton directly to owner controls and Created, then fills crew and counts", async (t) => {
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(() => {}));
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.me.presales(true), { created: [], positions: [], watchlist: [], coins: [], vestings: [] });
  const container = document.createElement("div");
  document.body.append(container);
  container.innerHTML = renderToString(tree(true));
  const hydrationErrors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => { root = hydrateRoot(container, tree(true), { onRecoverableError: (error) => hydrationErrors.push(error) }); });
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  function tree(pending: boolean) {
    return (
      <AppRouterContext value={router}><PathnameContext value="/@kai"><QueryProvider client={client}>
        <SocialAccountContext value={{ status: "loading", account: null, refresh() {} }}>
          <SocialViewerProvider signedIn={!pending} sessionPending={pending} callsign={pending ? null : "kai"}>
            <ProfileView initialCalls={null} nowMs={0} profile={profile} />
          </SocialViewerProvider>
        </SocialAccountContext>
      </QueryProvider></PathnameContext></AppRouterContext>
    );
  }
  async function render(pending: boolean) {
    await act(async () => root.render(tree(pending)));
  }
  assert.deepEqual(hydrationErrors, []);
  assert.ok(container.querySelector('article[aria-busy="true"][inert]'));
  assert.equal(container.querySelector('[data-gated="sign-in"]'), null);
  assert.equal(container.querySelector(".gold"), null);
  assert.equal(container.querySelector(".crewCard"), null);
  await render(false);
  assert.equal(container.querySelector("article[inert]"), null);
  assert.equal(container.querySelector(".profActs button")?.getAttribute("aria-label"), "Edit profile", "Invites and Settings live in the account menu");
  assert.equal(container.querySelector('.seg button[aria-pressed="true"]')!.textContent, "Created");
  assert.equal(container.querySelector('[data-gated="sign-in"]'), null);
  await act(async () => {
    client.setQueryData(cardIdentityKey("kai"), { crew: 123, edition: "cosmic", published_card_id: null });
    client.setQueryData(queryKeys.me.connections.counts("kai", "kai"), { followers: 128, following: 42 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.querySelector(".crewCard")!.textContent!, /Cosmic cardSeason Zero · Crew #0123View card/);
  assert.match(container.querySelector(".counts")!.textContent!, /128 followers·42 following/);
  assert.equal(container.querySelector(".gold"), null);
});
