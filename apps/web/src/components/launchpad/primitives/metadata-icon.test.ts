import assert from "node:assert/strict";
import test from "node:test";

import { validMetadataIconUrl } from "./metadata-icon.ts";

test("real https metadata icons are accepted as given", () => {
  for (const url of [
    "https://arweave.net/Qm4x8vT3/helmet.png",
    "https://cdn.coinlaunch.xyz/icons/HLM.webp?v=3",
    "https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  ]) {
    assert.equal(validMetadataIconUrl(url), url);
  }
});

test("missing, malformed and non-https icons fall back", () => {
  for (const url of [
    null,
    undefined,
    "",
    "   ",
    "helmet.png",
    "http://arweave.net/helmet.png",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    `https://arweave.net/${"a".repeat(2048)}`,
  ]) {
    assert.equal(validMetadataIconUrl(url), null, String(url));
  }
});

test("placeholder and local hosts fall back", () => {
  for (const url of [
    "https://example.com/icon.png",
    "https://cdn.example.org/icon.png",
    "https://localhost/icon.png",
    "https://127.0.0.1/icon.png",
    "https://10.0.0.4/icon.png",
    "https://192.168.1.2/icon.png",
    "https://icons.test/icon.png",
    "https://icons.invalid/icon.png",
    "https://printer.local/icon.png",
    "https://localhost./icon.png",
    "https://cdn.example.com./icon.png",
    "https://intranet/icon.png",
    "https://intranet./icon.png",
    "https://your-cdn.com/<ICON_URL>",
    "https://cdn.coinlaunch.xyz/icons/YOUR_ICON_HERE.png",
    "https://cdn.coinlaunch.xyz/{{icon}}.png",
    "https://cdn.coinlaunch.xyz/placeholder.png",
  ]) {
    assert.equal(validMetadataIconUrl(url), null, url);
  }
});

test("icons whose URL carries credentials or secret-like parameters fall back", () => {
  for (const url of [
    "https://user:pass@cdn.coinlaunch.xyz/icon.png",
    "https://cdn.coinlaunch.xyz/icon.png?token=abc123",
    "https://cdn.coinlaunch.xyz/icon.png?api_key=abc123",
    "https://cdn.coinlaunch.xyz/icon.png?apiKey=abc123",
    "https://bucket.s3.amazonaws.com/icon.png?X-Amz-Signature=abc&X-Amz-Credential=def",
    "https://cdn.coinlaunch.xyz/icon.png?sig=abc",
    "https://cdn.coinlaunch.xyz/icon.png?access_token=abc",
    "https://cdn.coinlaunch.xyz/icon.png?secret=abc",
    "https://cdn.coinlaunch.xyz/icon.png#access_token=abc",
    "https://cdn.coinlaunch.xyz/icon.png#state=x&id_token=abc",
    "https://cdn.coinlaunch.xyz/icon.png#token=abc",
  ]) {
    assert.equal(validMetadataIconUrl(url), null, url);
  }
});
