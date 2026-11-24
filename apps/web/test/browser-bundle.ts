import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import ts from "@typescript/typescript6";

const root = fileURLToPath(new URL("../", import.meta.url));

// Vite normally replaces Node built-ins with empty browser shims. A successful
// bundle must instead mean these shared read clients can run without Node.
const browserCapabilities: Plugin = {
  name: "browser-capabilities",
  enforce: "pre",
  // Computed imports survive a bundle unchanged, so their targets cannot be checked.
  moduleParsed({ id, code }) {
    if (!code) return;
    const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
      ) {
        throw new Error(`Unresolved browser dependency in ${id}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  },
  async resolveId(source, importer, options) {
    if (isBuiltin(source) || source === "server-only") {
      throw new Error(`Browser dependency cannot load ${source}`);
    }
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (
      resolved &&
      (resolved.id.includes("/packages/server/") ||
        resolved.id.includes("/packages/core/src/modules/database/") ||
        resolved.id.endsWith("/apps/web/src/lib/server-config.ts"))
    ) {
      throw new Error(`Browser dependency cannot load ${resolved.id}`);
    }
    return resolved;
  },
};

export async function browserBundle(entry: string | string[]) {
  return build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [browserCapabilities],
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ["es"] },
    },
  });
}
