import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

let profile: { callsign: string; display_name: string } | null = null;
let failure: Error | null = null;
let reads = 0;
Object.assign(globalThis, { profileRouteFixture: async () => { reads++; if (failure) throw failure; return profile; } });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (decodeURI(context.parentURL ?? "").includes("/crew/[callsign]/")) {
      if (specifier === "./profile-reads") return { shortCircuit: true, url: "data:text/javascript,export const profileOf=(name)=>globalThis.profileRouteFixture(name);export const profileCallsOf=async()=>null;export const requestNow=()=>0;" };
      if (specifier === "next/server") return { shortCircuit: true, url: "data:text/javascript,export const connection=async()=>{}" };
    }
    return nextResolve(specifier, context);
  },
});
const { generateMetadata } = await import("./page");
const { connectionsPage } = await import("./connections-page");
const params = () => Promise.resolve({ callsign: "kaimoreno" });

test("missing profiles remain not-found; backend failures reject metadata and connections instead of becoming a public identity", async () => {
  assert.deepEqual(await generateMetadata({ params: params() }), { title: "Page not found" });
  await assert.rejects(connectionsPage(params()), /NEXT_HTTP_ERROR_FALLBACK;404/);
  profile = { callsign: "kaimoreno", display_name: "Kai" };
  assert.deepEqual(await generateMetadata({ params: params() }), { title: "Kai" });
  assert.equal((await connectionsPage(params())).props.profile, profile);
  failure = new Error("backend unavailable");
  await assert.rejects(generateMetadata({ params: params() }), error => error === failure);
  await assert.rejects(connectionsPage(params()), error => error === failure);
  const before = reads;
  assert.deepEqual(await generateMetadata({ params: Promise.resolve({ callsign: "invalid!" }) }), { title: "Page not found" });
  await assert.rejects(connectionsPage(Promise.resolve({ callsign: "invalid!" })), /NEXT_HTTP_ERROR_FALLBACK;404/);
  assert.equal(reads, before, "invalid routes never read the backend");
});
