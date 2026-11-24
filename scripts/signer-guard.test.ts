import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * T-008 (AC-106): no presale code path holds or requests a signer for a
 * participant's wallet. Blast never signs for an embedded wallet; Privy signs
 * in the browser. Only the listed role-specific worker modules may create
 * signers in the scanned source trees. Test fixtures can play the browser.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** Every presale source tree, in each package: modules, its web routes, and its scripts; plus the gas sponsor. */
const PRESALE_SOURCES = [
  ...["apps/web", "apps/workers", "packages/core", "packages/server"].flatMap((pkg) =>
    ["src/modules/presale", "src/app/api/presale", "src/app/api/account", "scripts"].map((tree) => `${pkg}/${tree}`)),
  "packages/core/src/modules/sponsor",
  "packages/server/src/modules/sponsor",
  "packages/server/src/lib/privy-adapter",
  "apps/workers/src/modules/blast-keeper",
  "apps/workers/src/modules/launch-migration",
  "apps/workers/src/modules/reward-plan",
  "apps/workers/src/modules/rewards-planner",
  "apps/workers/src/modules/vault-rewards",
  "apps/workers/src/modules/vault-buyback",
];
const SCRIPT = /^(?:apps\/[a-z]+|packages\/(?:core|server))\/scripts\//;
const PRESALE_SCRIPT = /\/scripts\/presale-/;

const WALLET_PROVISIONING_FILES: ReadonlySet<string> = new Set([
  "packages/server/src/lib/privy-adapter/adapter.ts",
  "packages/server/src/lib/privy-adapter/http-gateway.ts",
]);

/**
 * The canonical launch stack has one isolated signer per execution role.
 * These modules enforce each role's transaction policy before signing.
 */
const ALLOWED_SIGNER_FILES: ReadonlySet<string> = new Set([
  "apps/workers/src/modules/blast-keeper/signer.ts",
  "apps/workers/src/modules/vault-rewards/signer.ts",
  "apps/workers/src/modules/vault-buyback/signer.ts",
]);

/** Constructs that create, load or request a signer, and Privy wallet signing. */
const SIGNER_CONSTRUCTS: readonly [string, RegExp][] = [
  ["Sui keypair", /\b(?:Ed25519|Secp256k1|Secp256r1|Passkey)Keypair\b|@mysten\/sui\/keypairs/],
  ["private key decoding", /\bdecodeSuiPrivateKey\b|\bfromSecretKey\b|\bderiveKeypair\b|\bsuiprivkey1/],
  ["generic Signer", /@mysten\/sui\/cryptography['"]|\bextends\s+Signer\b|\bimplements\s+Signer\b/],
  ["transaction or message signing", /\.sign(?:Transaction|PersonalMessage|AndExecuteTransaction|WithIntent)\s*\(/],
  ["Privy wallet RPC", /\/v1\/wallets\/[^"'`]*\/rpc|\bwallets\/\$\{[^}]+\}\/rpc|privy-authorization-signature|authorization[_-]?key/i],
  ["Privy server SDK", /@privy-io\/(?:server-auth|node)/],
  ["embedded wallet creation", /\bcreateEmbeddedSuiWallet\b|\bverifyXIdentityAndResolveWallet\b/],
];

function signerConstructs(source: string): string[] {
  // The exact parser-only import reads signatures without creating a signer.
  const withoutParserImport = source.replace(
    /^import \{ parseSerializedSignature \} from "@mysten\/sui\/cryptography";\r?$/gm,
    "",
  );
  return SIGNER_CONSTRUCTS.filter(([, pattern]) => pattern.test(withoutParserImport)).map(([name]) => name);
}

function sourceFiles(directory: string): string[] {
  const absolute = join(ROOT, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((entry) => {
    const path = join(absolute, entry);
    const relativePath = relative(ROOT, path);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : sourceFiles(relativePath);
    return /\.(?:ts|tsx|mjs|js)$/.test(entry) ? [relativePath] : [];
  });
}

/**
 * Fixture files only tests import, by exact path. A fixture may play the
 * browser, so it is exempt; any other file, whatever its name, is scanned.
 * Today none of them signs; a new one is added here on review.
 */
const TEST_FIXTURE_FILES: ReadonlySet<string> = new Set(["packages/core/test/fixtures/modules/presale/deployment/fixtures.ts"]);

const isTestOnly = (path: string) => /\.test\.tsx?$/.test(path) || TEST_FIXTURE_FILES.has(path);

test("the guard recognizes every signer construct and passes ordinary presale code", () => {
  for (const [source, expected] of [
    ['import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";', "Sui keypair"],
    ["const { secretKey } = decodeSuiPrivateKey(process.env.KEY);", "private key decoding"],
    ['import type { Signer } from "@mysten/sui/cryptography";', "generic Signer"],
    ['import { parseSerializedSignature, Signer } from "@mysten/sui/cryptography";', "generic Signer"],
    ["await keypair.signTransaction(bytes);", "transaction or message signing"],
    ["await wallet.signPersonalMessage(message);", "transaction or message signing"],
    ["fetch(`https://api.privy.io/v1/wallets/${walletId}/rpc`)", "Privy wallet RPC"],
    ['headers["privy-authorization-signature"] = value;', "Privy wallet RPC"],
    ['import { PrivyClient } from "@privy-io/server-auth";', "Privy server SDK"],
    ["await gateway.createEmbeddedSuiWallet({ chainType: 'sui', ownerPrivyDid });", "embedded wallet creation"],
  ] as const) {
    assert.deepEqual(signerConstructs(source), [expected], source);
  }
  for (const benign of [
    'import { parseSerializedSignature } from "@mysten/sui/cryptography";',
    'import { verifyTransactionSignature } from "@mysten/sui/verify";',
    "const user_signature = body.user_signature; // the browser's signature, verified then forwarded",
    "await resolver.resolveEmbeddedSuiWallet(did);",
  ]) {
    assert.deepEqual(signerConstructs(benign), [], benign);
  }
});

test("only test files and the listed fixture files are exempt, never any file named fixtures.ts (B-005)", () => {
  assert.equal(isTestOnly("src/modules/presale/route-kit/route-kit.test.ts"), true);
  assert.equal(isTestOnly("packages/core/test/fixtures/modules/presale/deployment/fixtures.ts"), true);
  for (const path of ["src/modules/presale/fixtures.ts", "src/modules/presale/route-kit/testing.ts", "src/app/api/presale/fixtures.ts"]) {
    assert.equal(isTestOnly(path), false, path);
  }
});

test("presale source and launch workers allow only the listed execution signers", () => {
  const files = PRESALE_SOURCES.flatMap(sourceFiles).filter(
    (path) => (SCRIPT.test(path) ? PRESALE_SCRIPT.test(path) : true) && !isTestOnly(path),
  );
  assert.ok(files.some((path) => path.includes("/src/modules/presale/route-kit/")), "the scan reaches the presale modules");
  assert.ok(files.includes("packages/server/src/modules/presale/embedded-wallets/service.ts"));
  assert.ok(files.includes("packages/server/src/modules/sponsor/execute.ts"));
  assert.ok(files.includes("packages/core/src/modules/sponsor/policy.ts"));
  assert.ok(files.includes("packages/server/scripts/presale-api-keys.ts"));
  for (const path of [...ALLOWED_SIGNER_FILES, ...WALLET_PROVISIONING_FILES]) {
    assert.ok(files.includes(path), `the scan reaches ${path}`);
  }
  const offenders = files.flatMap((path) => {
    const found = signerConstructs(readFileSync(join(ROOT, path), "utf8"));
    if (found.length === 0) return [];
    // The existing Privy adapter provisions wallets without signing for them.
    if (WALLET_PROVISIONING_FILES.has(path) && found.every((name) => name === "embedded wallet creation")) return [];
    const privyWallet = found.filter((name) => name.startsWith("Privy") || name === "embedded wallet creation");
    // An allowed server signer still never touches a Privy (participant) wallet.
    return ALLOWED_SIGNER_FILES.has(path) && privyWallet.length === 0 ? [] : [`${path}: ${found.join(", ")}`];
  });
  assert.deepEqual(offenders, []);

  assert.ok(ALLOWED_SIGNER_FILES.size <= 3, "three worker keys at most");
  for (const path of TEST_FIXTURE_FILES) assert.ok(existsSync(join(ROOT, path)), path);
});
