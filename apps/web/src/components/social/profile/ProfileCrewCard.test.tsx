import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { installTestDom, recordAnimations } from "../../../../test/fixtures/social/test-dom.ts";
import { cardIdentityKey, OWNER_CARD_PATH } from "@blast/core/modules/social/contracts/card-identity.ts";
import { publicCardImagePath } from "@blast/core/modules/mission-control/card-images/contracts.ts";

const { document } = installTestDom();
// The browser verifies Next's image component; this DOM test needs only its rendered image.
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve("react")).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/image") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`import {createElement} from ${JSON.stringify(reactUrl)}; export default function Image({unoptimized, ...props}) { return createElement('img', props); }`)}` };
  return nextResolve(specifier, context);
} });
const motion = recordAnimations();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { ProfileCrewCard } = await import("./ProfileCrewCard");
const { renderToStaticMarkup } = await import("react-dom/server");

test("profile loading reserves a crew-card row only when a card is known", () => {
  for (const identity of [undefined, null, { crew: 123, edition: "countdown", published_card_id: null }]) {
    const client = createTestQueryClient();
    if (identity !== undefined) client.setQueryData(cardIdentityKey("kai"), identity);
    try {
      const html = renderToStaticMarkup(<QueryProvider client={client}><ProfileCrewCard callsign="kai" loading own /></QueryProvider>);
      assert.equal(/Season Zero/.test(html), Boolean(identity), "unknown and known-absent cards must not invent a row that disappears");
    } finally { client.clear(); }
  }
});

test("owners fetch unpublished artwork with their social credentials; visitors see only published cards", async () => {
  const originalFetch = globalThis.fetch, originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const reads: { url: string; init?: RequestInit }[] = [], revoked: string[] = [];
  let number = 0;
  let finishCardRead: (() => void) | undefined;
  let pendingCardRead: Promise<void> | undefined;
  let failure: "auth" | "401" | "mime" | "offline" | null = null;
  URL.createObjectURL = () => `blob:crew-${++number}`;
  URL.revokeObjectURL = (url) => void revoked.push(url);
  globalThis.fetch = async (input, init) => {
    reads.push({ url: String(input), init });
    await pendingCardRead;
    if (failure === "offline") throw new Error("offline");
    if (failure === "401") return new Response(null, { status: 401 });
    if (failure === "mime") return new Response("not a card", { headers: { "content-type": "text/html" } });
    return new Response("fixture", { headers: { "content-type": "image/png" } });
  };
  async function checkFailures(view: HTMLButtonElement) {
    for (const refusal of ["auth", "401", "mime", "offline"] as const) {
      failure = refusal;
      await act(async () => view.click());
      await act(async () => motion.finishAll());
      const dialog = document.querySelector('[role="dialog"]')!;
      assert.match(dialog.querySelector('[role="status"]')!.textContent!, refusal === "auth" || refusal === "401" ? /Sign in again/ : refusal === "offline" ? /Code: request_failed/ : /Code: invalid_response/);
      const retry = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Retry card")!;
      assert.equal(retry.disabled, false, "a failed read clears busy and permits retry");
      assert.equal(dialog.querySelector("a"), null, "failed or invalid artwork cannot be downloaded");
    }
    failure = null;
  }
  try {
    for (const own of [true, false]) {
      const client = createTestQueryClient();
      const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      client.setQueryData(cardIdentityKey("kai"), { crew: 123, edition: "countdown", published_card_id: own ? null : id });
      const container = document.createElement("div");
      container.setAttribute("data-blast-ui", "");
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => root.render(<QueryProvider client={client}>
          <SocialViewerProvider callsign={own ? "kai" : null} getAccessToken={async () => {
            if (failure === "auth") throw new Error("offline");
            return "owner-token";
          }} signedIn={own}>
            <ProfileCrewCard callsign="kai" own={own} />
          </SocialViewerProvider>
        </QueryProvider>));
        assert.match(container.textContent, /Crew #0123/);
        assert.match(container.textContent, /Countdown · 1 of 1 card/);
        const view = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "View card")!;
        view.focus();
        if (own) await checkFailures(view);
        pendingCardRead = new Promise<void>((resolve) => { finishCardRead = resolve; });
        await act(async () => view.click());
        await act(async () => motion.finishAll());
        const loadingDialog = document.querySelector('[role="dialog"]')!;
        assert.ok(loadingDialog.querySelector('[role="status"][aria-label="Loading crew card"][aria-busy="true"]'), "pending artwork shows an accessible card preview skeleton");
        assert.equal(loadingDialog.querySelector("img"), null);
        assert.equal(Array.from(loadingDialog.querySelectorAll("button")).some((button) => /Retry card|Loading card/.test(button.textContent!)), false, "retry controls appear only after the read settles");
        await act(async () => { finishCardRead!(); });
        pendingCardRead = undefined;
        assert.equal(loadingDialog.querySelector('[aria-busy="true"]'), null, "the card replaces its skeleton after loading");
        const read = reads.at(-1)!;
        assert.equal(read.url, own ? OWNER_CARD_PATH : publicCardImagePath(id, "card"));
        assert.equal(read.init?.cache, own ? "no-store" : "default");
        assert.equal(new Headers(read.init?.headers).get("authorization"), own ? "Bearer owner-token" : null);
        const dialog = document.querySelector('[role="dialog"]')!;
        assert.equal(Array.from(dialog.querySelectorAll("button")).some((button) => /Reload card|Retry card/.test(button.textContent!)), false, "success shows the card without a reload or retry action");
        assert.equal(document.activeElement, dialog, "loading opens with focus inside the dialog");
        assert.equal(Array.from(dialog.querySelectorAll("a")).some((link) => link.textContent === "Download PNG"), own);
        if (own) assert.equal(dialog.querySelector("a")!.getAttribute("download"), "blast-season-zero-kai.png");
        await act(async () => Array.from(dialog.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "Close")!.click());
        await act(async () => motion.finishAll());
        assert.equal(document.activeElement, view, "closing restores the opener's focus");
      } finally {
        await act(async () => root.unmount()); client.clear(); container.parentNode?.removeChild(container);
      }
    }
    assert.deepEqual(revoked, ["blob:crew-1", "blob:crew-2"]);
  } finally {
    globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  }
});
