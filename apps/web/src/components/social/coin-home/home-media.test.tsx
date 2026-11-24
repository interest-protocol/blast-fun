import assert from "node:assert/strict";
import test from "node:test";
import {
  installTestDom,
  testEvent,
} from "../../../../test/fixtures/social/test-dom.ts";

installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Avatar, PresaleMark } = await import("../post/PostMedia");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");

test("failed Home account and token images retain generated identity marks", async (t) => {
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  });
  await act(async () =>
    root.render(
      <QueryProvider client={client}>
        <Avatar
          callsign="reader"
          src="https://design-assets.blast.fun/missing-avatar.png"
          size={30}
        />
        <PresaleMark
          presaleId="treasury"
          src="https://design-assets.blast.fun/missing-token.png"
          size={34}
        />
      </QueryProvider>,
    ),
  );
  const images = [...container.querySelectorAll("img")];
  assert.equal(images.length, 2);
  await act(async () =>
    images.forEach((image) =>
      image.dispatchEvent(testEvent("error", { bubbles: false })),
    ),
  );
  assert.equal(
    container.querySelectorAll("img").length,
    0,
    "a failed URL must not leave a broken-image icon",
  );
  assert.equal(
    container.querySelectorAll(
      'svg[data-avatar="generated"], svg[data-generated]',
    ).length,
    2,
  );
  assert.equal(
    container.querySelectorAll('span[aria-hidden="true"]').length >= 2,
    true,
    "the media wrappers remain alongside the names",
  );
});
