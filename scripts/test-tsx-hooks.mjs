// Lets `node --test` render React components: it compiles `.tsx` with the
// project's TypeScript, resolves extensionless imports the way the
// Next bundler does (including extensionless package subpaths), and turns CSS modules into class-name maps. Plain `.ts`
// files keep using Node's own type stripping.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// TanStack Query's timers (each cached query's `gcTime`, 5 minutes in the app;
// retry sleeps) still fire while a test runs, but must not keep the test
// file's process alive once its tests are done. Unref'd, they no longer do.
// Only under `node --test` (it sets NODE_TEST_CONTEXT in each test file's
// process): the workers also load this file in production.
if (process.env.NODE_TEST_CONTEXT) {
  const { timeoutManager } = await import("@tanstack/react-query");
  timeoutManager.setTimeoutProvider({
    setTimeout: (callback, delay) => setTimeout(callback, delay).unref(),
    clearTimeout,
    setInterval: (callback, delay) => setInterval(callback, delay).unref(),
    clearInterval,
  });
}

const require = createRequire(import.meta.url);
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];
let typescript;

// Only project sources use bundler-style specifiers; packages resolve normally.
function localCandidate(specifier, parentURL) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && parentURL?.startsWith("file:") && !parentURL.includes("/node_modules/")) {
    return new URL(specifier, parentURL);
  }
  return null;
}

function existingFile(url) {
  const path = fileURLToPath(url);
  return existsSync(path) && !statSync(path).isDirectory();
}

// `server-only` is a Next bundler marker with no Node entry. Server components
// reach it through `webConfig()`, so tests that render them get an empty module.
// Only under `node --test`, as above: production workers must never stub it.
const testRun = Boolean(process.env.NODE_TEST_CONTEXT);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (testRun && specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    const candidate = localCandidate(specifier, context.parentURL);
    if (candidate) {
      const match = [candidate, ...EXTENSIONS.map((extension) => new URL(candidate.href + extension))]
        .find(existingFile);
      if (match) return { url: match.href, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      // Packages without an exports map (such as `next/navigation`) resolve
      // extensionless subpaths only in bundlers.
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || candidate || !specifier.includes("/")) throw error;
      return nextResolve(`${specifier}.js`, context);
    }
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".module.css")) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default new Proxy({}, { get: (_, name) => String(name) });",
      };
    }
    if (url.endsWith(".tsx")) {
      typescript ??= require("typescript");
      const { outputText } = typescript.transpileModule(readFileSync(new URL(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: {
          jsx: typescript.JsxEmit.ReactJSX,
          module: typescript.ModuleKind.ESNext,
          target: typescript.ScriptTarget.ES2022,
          verbatimModuleSyntax: true,
        },
      });
      return { format: "module", shortCircuit: true, source: outputText };
    }
    return nextLoad(url, context);
  },
});
