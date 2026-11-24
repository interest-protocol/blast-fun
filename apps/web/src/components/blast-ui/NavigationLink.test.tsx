import assert from "node:assert/strict";
import test from "node:test";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { Suspense, use, useState } from "react";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { RouterContext } = await import("next/dist/shared/lib/router-context.shared-runtime");
const { PrimaryLink } = await import("./NavigationLink");

// Node resolves Link's Pages entry; the navigation handler is shared.
const linkRouter = {
  basePath: "", route: "/", pathname: "/", query: {}, asPath: "/", isFallback: false, isReady: true, isPreview: false, isLocaleDomain: false,
  push: async () => true, replace: async () => true, prefetch: async () => {},
  reload() {}, back() {}, forward() {}, beforePopState() {}, events: { on() {}, off() {}, emit() {} },
};

function Destination({ read }: Readonly<{ read: Promise<string> }>) {
  return <p>{use(read)}</p>;
}

test("primary navigation marks a pending link without a loading overlay; prevented links stay put", async () => {
  let resolve!: (value: string) => void;
  const destination = new Promise<string>((done) => { resolve = done; });
  const requests: string[] = [];
  function App() {
    const [read, setRead] = useState<Promise<string> | null>(null);
    const router = {
      bfcacheId: "test", back() {}, forward() {}, refresh() {}, prefetch() {}, replace() {},
      push(href: string) { requests.push(href); setRead(destination); },
    } satisfies AppRouterInstance;
    return <AppRouterContext value={router}><RouterContext value={linkRouter}><PrimaryLink href="/portfolio" prefetch={false}>Portfolio</PrimaryLink><PrimaryLink href="/sign-in" onClick={(event) => event.preventDefault()} prefetch={false}>Sign in</PrimaryLink><Suspense fallback={<p>Loading destination</p>}>{read ? <Destination read={read} /> : <p>Home</p>}</Suspense></RouterContext></AppRouterContext>;
  }
  const host = dom.document.createElement("div");
  host.setAttribute("data-blast-ui", "");
  dom.document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<App />));
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]')!.click());
    assert.deepEqual(requests, []);
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="/portfolio"]')!.click());
    assert.deepEqual(requests, ["/portfolio"]);
    assert.ok(host.querySelector('a[href="/portfolio"] [data-pending]'));
    assert.doesNotMatch(dom.document.body.textContent, /Loading page/);
    assert.equal(dom.document.querySelector('[role="status"]'), null);
    assert.match(host.textContent, /Home/);
    await act(async () => { resolve("Your portfolio"); });
    assert.match(host.textContent, /Your portfolio/);
    assert.equal(host.querySelector("[data-pending]"), null);
    assert.doesNotMatch(dom.document.body.textContent, /Loading page/);
  } finally {
    await act(async () => root.unmount());
    dom.document.body.removeChild(host);
  }
});
