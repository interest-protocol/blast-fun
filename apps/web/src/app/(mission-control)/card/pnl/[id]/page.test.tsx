import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FilesystemCardImageStore } from "@blast/server/modules/mission-control/card-images/store.ts";
import { installRuntimeConfig } from "../../../../../../../../packages/server/test/fixtures/config/runtime-config.ts";

// Presentation fixture reads the real canonical snapshot store; native HTTP parity
// is exercised separately by the backend family integration test.
const canonicalReader = import.meta.resolve(
  "@blast/server/modules/social/pnl-card-sharing.ts",
);
// Node exposes next/image's CJS wrapper; Next's bundler unwraps its default.
const imageUrl = pathToFileURL(
  createRequire(import.meta.url).resolve("next/image"),
).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "#web/lib/backend-api/cards.ts")
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`import { readPnlCardShare } from ${JSON.stringify(canonicalReader)}; export async function readPnlPageFromBackend(id) { return { id, exists: (await readPnlCardShare(id)) !== null }; }`)}`,
      };
    if (specifier === "next/image")
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`import Image from ${JSON.stringify(imageUrl)}; export default Image.default;`)}`,
      };
    return nextResolve(specifier, context);
  },
});
const { default: SharedPnlCard, generateMetadata } = await import("./page");

test("PnL landing pages keep the referral on entry and social links while serving the same snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "blast-pnl-page-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  installRuntimeConfig({ CARD_IMAGE_DIRECTORY: directory, BLOB_READ_WRITE_TOKEN: undefined });
  const id = "a".repeat(64);
  const path = `/card/pnl/${id}`;
  await new FilesystemCardImageStore(directory).write(
    `pnl-cards/${id}.png`,
    Buffer.from("snapshot"),
  );
  for (const ref of [
    "nova",
    "NOVA",
    undefined,
    "../invalid",
    ["nova", "other"],
  ]) {
    const props = {
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve({ ref }),
    };
    const html = renderToStaticMarkup(await SharedPnlCard(props));
    const valid = typeof ref === "string" && ref.toLowerCase() === "nova";
    assert.ok(
      html.includes(`href="${valid ? "/?ref=nova" : "/"}">Trade on Blast</a>`),
    );
    assert.ok(html.includes(`src="${path}/image"`));
    const metadata = await generateMetadata(props);
    assert.ok(
      String(metadata.openGraph?.url).endsWith(
        `${path}${valid ? "?ref=nova" : ""}`,
      ),
    );
    assert.doesNotMatch(JSON.stringify(metadata.twitter), /\/image\?ref=/);
  }
  await assert.rejects(
    SharedPnlCard({
      params: Promise.resolve({ id: "b".repeat(64) }),
      searchParams: Promise.resolve({ ref: "nova" }),
    }),
    /NEXT_HTTP_ERROR_FALLBACK;404/,
  );
});
