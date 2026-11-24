import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ProfileView } from "../ProfileView";
import { SocialViewerProvider } from "../SignInGate";
import { ProfileLoading } from "./ProfileLoading";

const profile = { callsign: "kai", display_name: "Kai", avatar_url: null, x_handle: null, verified: false, private: false, portfolio_public: true };
const router: AppRouterInstance = { bfcacheId: "loading-test", push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };

test("a hard refresh keeps a skeleton until the viewer is resolved instead of flashing Follow and a public portfolio", () => {
  const html = renderToStaticMarkup(<AppRouterContext value={router}><SocialViewerProvider signedIn={false} sessionPending><ProfileView profile={profile} initialCalls={null} nowMs={0} /></SocialViewerProvider></AppRouterContext>);
  assert.match(html, /aria-label="Loading profile"/);
  assert.doesNotMatch(html, /<button[^>]*>Follow|class="gold gold2"/);
});

test("the owner route skeleton reserves connections and owner sections without inventing an optional crew card", () => {
  const html = renderToStaticMarkup(<AppRouterContext value={router}><PathParamsContext value={{ callsign: "kai" }}><SocialViewerProvider signedIn callsign="kai"><ProfileLoading /></SocialViewerProvider></PathParamsContext></AppRouterContext>);
  assert.match(html, /followers/);
  assert.match(html, /following/);
  assert.doesNotMatch(html, /Season Zero.*Crew/);
  assert.match(html, /Created/);
  assert.match(html, /Backed/);
  assert.doesNotMatch(html, /Presale calls/);
});


test("unknown ownership never invents owner controls or a private-account denial", () => {
  const html = renderToStaticMarkup(<AppRouterContext value={router}><SocialViewerProvider signedIn sessionPending><ProfileView profile={{ ...profile, private: true }} initialCalls={null} nowMs={0} /></SocialViewerProvider></AppRouterContext>);
  assert.match(html, /aria-label="Loading profile"/);
  assert.doesNotMatch(html, /This account is private|Edit profile|>Invites<|>Settings<|>Created</);
});
