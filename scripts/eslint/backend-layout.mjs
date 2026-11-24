import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../apps/backend-api/src/", import.meta.url));
const sourceFiles = ["apps/backend-api/src/**/*.ts"];
const transportFiles = ["apps/backend-api/src/transport/**"];
const withinTransport = (path) => path.startsWith("transport/");
const bunMessage = "Use Bun only in backend transport.";

function processRole(path) {
  if (path === "main.ts") return "api";
  if (path === "hints-main.ts") return "hints";
  return /^app\/(api|hints)\//.exec(path)?.[1];
}

function violation(importer, specifier, directory) {
  if (/^(bun(?:[:/]|$)|@effect\/platform-bun(?:\/|$))/.test(specifier) && !withinTransport(importer)) {
    return bunMessage;
  }
  if (!/^\.\.?\//.test(specifier)) return;

  const target = relative(sourceRoot, resolve(directory, specifier)).split(sep).join("/");
  if (target === ".." || target.startsWith("../")) return;
  if (/^(hints-)?main(?:\.ts)?$/.test(target)) return "Import the startup module instead of an executable backend entry point.";
  if (withinTransport(importer) && !withinTransport(target)) return "Pass dependencies into transport from app composition.";
  const targetRole = processRole(target);
  if (targetRole && processRole(importer) !== targetRole) {
    return "Keep API and hints wiring independent. Put shared wiring directly under app.";
  }
}

const layout = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const importer = relative(sourceRoot, context.filename).split(sep).join("/");
    const directory = dirname(context.filename);

    function check(node) {
      const specifier = node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : node?.value;
      if (typeof specifier !== "string") return;
      const message = violation(importer, specifier, directory);
      if (message) context.report({ node, message });
    }

    return {
      "ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, ImportExpression, TSImportType": (node) => check(node.source),
      TSExternalModuleReference: (node) => check(node.expression),
      "CallExpression[callee.name='require']": (node) => check(node.arguments[0]),
    };
  },
};

export const backendLayout = [
  {
    files: sourceFiles,
    plugins: {
      "blast-backend": {
        meta: {
          name: "blast-backend",
          version: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
        },
        rules: { layout },
      },
    },
    rules: {
      "blast-backend/layout": "error",
      "no-console": "error",
    },
  },
  {
    files: sourceFiles,
    ignores: transportFiles,
    rules: {
      "no-restricted-globals": ["error", {
        globals: [{ name: "Bun", message: bunMessage }],
        checkGlobalObject: true,
      }],
    },
  },
];
