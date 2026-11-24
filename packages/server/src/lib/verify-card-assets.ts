import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import assets from "./card-assets.manifest.json" with { type: "json" };
import { cardAssetPath } from "./card-assets.ts";

for (const asset of assets) {
  const bytes = await readFile(cardAssetPath(asset.path));
  assert.equal(bytes.length, asset.bytes, `Card asset size: ${asset.path}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256,
    `Card asset hash: ${asset.path}`);
}
const root = new URL("../../assets/mission-control/", import.meta.url);
const packaged = await readdir(root, { recursive: true });
const paths = packaged.filter((path) => !["fonts", "editions", "fonts/LICENSE.txt", "fonts/README.md"].includes(path)).sort();
assert.deepEqual(paths, assets.map((asset) => asset.path).sort(), "Exact card asset package");
console.log(`Verified ${assets.length} immutable card assets`);
