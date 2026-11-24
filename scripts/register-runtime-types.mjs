// Native Node runs this backend without Next, React, CSS or test-only hooks.
import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const candidate = new URL(specifier, context.parentURL);
      const match = [candidate, ...[".ts", "/index.ts"].map((suffix) => new URL(candidate.href + suffix))]
        .find((url) => existsSync(fileURLToPath(url)) && statSync(fileURLToPath(url)).isFile());
      if (match) return { url: match.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
