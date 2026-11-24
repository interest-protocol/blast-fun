import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// These reviewed JOSE chunks contain an importPKCS8 delimiter check without
// key material. Keep the scanner active for every artifact with different bytes.
const joseChunks = {
  ".next/static/chunks/15__8mnhei9wn.js": "eccaaa13002efe149ae44c6a2ef270efc8249d89cce306597c037485fbe08135",
  ".next/static/chunks/3yr20slpsh_65.js": "dc5aef5d3568d97bffb66ede933963129e9b6723ce2d3d11849661f3ff1c1183",
};

const verifiedChunks = Object.entries(joseChunks)
  .filter(([path, digest]) => {
    try {
      const file = readFileSync(new URL(path, import.meta.url));
      return createHash("sha256").update(file).digest("hex") === digest;
    } catch {
      return false;
    }
  })
  .map(([path]) => ({ files: [path], rules: ["react-doctor/artifact-secret-leak"] }));

const config = {
  ignore: {
    overrides: verifiedChunks,
  },
};

export default config;
