/**
 * Test-only derivation of the sponsor's generated allowlists (T-015). It
 * builds every commit the SDK can emit and every Cetus sponsored-mode swap the
 * fixtures cover, across every way Sui sources the sender's coins, and records
 * each function they call:
 *
 * - `framework-calls.ts`: every `0x1`/`0x2` function, by full target;
 * - `swap-calls.ts`: every Cetus function, by `module::function` (the package
 *   comes from `PRESALE_SPONSOR_SWAP_TARGETS`).
 *
 * For each function it records its argument and type-argument counts, each
 * argument's kind (pure, shared or owned object, withdrawal, or result), the
 * arguments that carried the sender (recipients), and, for swap functions
 * only, the 32-byte pure values that were not the sender (pinned, such as a
 * staking validator or the zero fee recipient) and its shared-object
 * arguments: pinned at the id every build passed (a `Partner`, a config, the
 * clock), or `null` where the build passed its own route pool. `framework-calls.test.ts` compares the result with both files.
 */
import { fileURLToPath } from "node:url";

import { fromBase64, normalizeStructTag, normalizeSuiAddress, toHex } from "@mysten/sui/utils";

import {
  CETUS_DERIVATION_POOLS,
  CETUS_FIXTURE_PROVIDERS,
  COIN_SOURCES,
  COMMIT_ROUTES,
  PRESALE_PACKAGE,
  QUOTE,
  SENDER,
  cetusSponsoredSwap,
  cetusSwapAndCommit,
  kindOf,
  sdkCommit,
} from "./fixtures.ts";
import { SWAP_CONTEXT, SWAP_OUTPUT } from "../../../../src/modules/sponsor/cetus-router.ts";
import { argumentKind, type SponsorArgumentKind } from "../../../../src/modules/sponsor/argument-kinds.ts";
import type { SponsorDerivedCall, SponsorTransactionKind } from "../../../../src/modules/sponsor/policy.ts";

export const FRAMEWORK_CALLS_PATH = fileURLToPath(new URL("../../../../src/modules/sponsor/framework-calls.ts", import.meta.url));
export const SWAP_CALLS_PATH = fileURLToPath(new URL("../../../../src/modules/sponsor/swap-calls.ts", import.meta.url));

const FRAMEWORK_PACKAGES = new Set([normalizeSuiAddress("0x1"), normalizeSuiAddress("0x2")]);
const CETUS_AMOUNT = 1_000_000_000n;

/** Each fixture build: its label, its kind, and the route pool it swaps through, if any. */
async function* fixtureKinds(): AsyncGenerator<[string, SponsorTransactionKind, string?]> {
  for (const source of COIN_SOURCES) {
    for (const route of COMMIT_ROUTES) {
      yield [`SDK commit ${route} (${source})`, await kindOf(sdkCommit(route), { source })];
    }
    for (const provider of CETUS_FIXTURE_PROVIDERS) {
      const options = { source, amount: CETUS_AMOUNT };
      for (const pool of CETUS_DERIVATION_POOLS) {
        const route = `${provider} via pool ${pool.slice(0, 6)}… (${source})`;
        yield [`Cetus swap-and-commit ${route}`, await kindOf(await cetusSwapAndCommit(provider, CETUS_AMOUNT, pool), options), pool];
        yield [`Cetus sponsored swap ${route}`, await kindOf(await cetusSponsoredSwap(provider, CETUS_AMOUNT, pool), options), pool];
      }
    }
  }
}

/**
 * One call's shape in one build. `kinds` holds each argument's kind; `objects`
 * maps each shared-object argument to its id, or to `null` when it is that
 * build's route pool. Shapes of the same function merge: counts, recipients,
 * pinned addresses, and object positions must agree, argument kinds are
 * united, and a shared object must be the same id in every build or the route
 * pool in every build. Anything else stops the derivation, so `null` can only
 * ever mean the route pool.
 */
type Observed = {
  label: string;
  shape: string;
  argumentCount: number;
  typeArgumentCount: number;
  recipients: number[];
  fixed: { position: number; value: string }[];
  objects: Map<number, string | null>;
  kinds: Set<SponsorArgumentKind>[];
};

function observe(calls: Map<string, Observed>, key: string, observed: Observed): void {
  const seen = calls.get(key);
  if (!seen) {
    calls.set(key, observed);
    return;
  }
  const positions = (call: Observed) => [...call.objects.keys()].join();
  if (seen.shape !== observed.shape || positions(seen) !== positions(observed)) {
    throw new Error(`${key} takes ${seen.shape} objects [${positions(seen)}] in ${seen.label} but ${observed.shape} objects [${positions(observed)}] in ${observed.label}`);
  }
  for (const [position, objectId] of observed.objects) {
    const before = seen.objects.get(position);
    if (before !== objectId) {
      throw new Error(`${key} argument ${position} is ${before ?? "the route pool"} in ${seen.label} but ${objectId ?? "the route pool"} in ${observed.label}`);
    }
  }
  observed.kinds.forEach((kinds, position) => kinds.forEach((kind) => seen.kinds[position].add(kind)));
}

function pureBytes(kind: SponsorTransactionKind, argument: { $kind: string; Input?: number } | undefined): Uint8Array | undefined {
  const pure = argument?.$kind === "Input" ? kind.ProgrammableTransaction!.inputs[argument.Input!].Pure : undefined;
  return pure && fromBase64(pure.bytes);
}

/**
 * The Cetus router layout the policy's fee and output checks rely on: the
 * swap context's fee rate is a `u32` and its fee recipient an address, and the
 * confirmed output of every fixture swap is the Quote.
 */
function assertRouterLayout(label: string, kind: SponsorTransactionKind): void {
  for (const command of kind.ProgrammableTransaction!.commands) {
    const call = command.MoveCall;
    if (!call) continue;
    const name = `${call.module}::${call.function}`;
    if (name === SWAP_CONTEXT.function) {
      if (pureBytes(kind, call.arguments[SWAP_CONTEXT.feeRate])?.length !== 4) throw new Error(`${label}: ${name} fee rate moved`);
      if (pureBytes(kind, call.arguments[SWAP_CONTEXT.feeRecipient])?.length !== 32) throw new Error(`${label}: ${name} fee recipient moved`);
    }
    if (name === SWAP_OUTPUT && normalizeStructTag(call.typeArguments[0]) !== QUOTE) {
      throw new Error(`${label}: ${name} type argument 0 is not the swap's output`);
    }
  }
}

export type DerivedLists = { framework: SponsorDerivedCall[]; swap: SponsorDerivedCall[] };

export async function deriveSponsorCalls(): Promise<DerivedLists> {
  const sender = normalizeSuiAddress(SENDER);
  const framework = new Map<string, Observed>();
  const swap = new Map<string, Observed>();
  function observeCall(
    label: string,
    kind: SponsorTransactionKind,
    call: NonNullable<NonNullable<SponsorTransactionKind["ProgrammableTransaction"]>["commands"][number]["MoveCall"]>,
    pool: string | undefined,
  ): void {
    const pkg = normalizeSuiAddress(call.package);
    if (pkg === PRESALE_PACKAGE) return;
    const isFramework = FRAMEWORK_PACKAGES.has(pkg);
    const key = isFramework ? `${pkg}::${call.module}::${call.function}` : `${call.module}::${call.function}`;
    const { inputs } = kind.ProgrammableTransaction!;
    const recipients: number[] = [];
    const fixed: { position: number; value: string }[] = [];
    const objects = new Map<number, string | null>();
    call.arguments.forEach((argument, index) => {
      const object = argument.$kind === "Input" ? inputs[argument.Input].Object : undefined;
      if (object?.Receiving) throw new Error(`${label}: ${key} argument ${index} is a Receiving object`);
      if (object?.SharedObject) {
        const objectId = normalizeSuiAddress(object.SharedObject.objectId);
        objects.set(index, pool !== undefined && objectId === normalizeSuiAddress(pool) ? null : objectId);
      }
      const bytes = pureBytes(kind, argument);
      if (bytes?.length !== 32) return;
      const address = normalizeSuiAddress(toHex(bytes));
      if (address === sender) recipients.push(index);
      else if (isFramework) throw new Error(`${label}: ${key} argument ${index} is a 32-byte value that is not the sender`);
      else fixed.push({ position: index, value: address });
    });
    if (isFramework && objects.size > 0) throw new Error(`${label}: ${key} takes a shared object`);
    observe(isFramework ? framework : swap, key, {
      label,
      shape: JSON.stringify([call.arguments.length, call.typeArguments.length, recipients, fixed]),
      argumentCount: call.arguments.length,
      typeArgumentCount: call.typeArguments.length,
      recipients,
      fixed,
      objects,
      kinds: call.arguments.map((argument) => new Set([argumentKind(inputs, argument)])),
    });
  }

  for await (const [label, kind, pool] of fixtureKinds()) {
    assertRouterLayout(label, kind);
    for (const command of kind.ProgrammableTransaction!.commands) {
      const call = command.MoveCall;
      if (!call) continue;
      observeCall(label, kind, call, pool);
    }
  }
  return { framework: entries(framework), swap: entries(swap) };
}

function entries(calls: Map<string, Observed>): SponsorDerivedCall[] {
  return [...calls]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([target, call]) => ({
      target,
      argumentCount: call.argumentCount,
      typeArgumentCount: call.typeArgumentCount,
      argumentKinds: call.kinds.map((kinds) => [...kinds].sort()),
      recipientArguments: call.recipients,
      fixedArguments: call.fixed,
      sharedObjects: [...call.objects].map(([position, objectId]) => ({ position, objectId })),
    }));
}

function render(name: string, header: string, calls: readonly SponsorDerivedCall[]): string {
  const literal = (item: object) =>
    `{ ${Object.entries(item)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ")} }`;
  const list = (items: readonly object[]) => (items.length ? `[${items.map(literal).join(", ")}]` : "[]");
  const entries = calls
    .map(
      (call) => `  {
    target: "${call.target}",
    argumentCount: ${call.argumentCount},
    typeArgumentCount: ${call.typeArgumentCount},
    argumentKinds: ${JSON.stringify(call.argumentKinds).replace(/,/g, ", ")},
    recipientArguments: [${call.recipientArguments.join(", ")}],
    fixedArguments: ${list(call.fixedArguments)},
    sharedObjects: ${list(call.sharedObjects)},
  },`,
    )
    .join("\n");
  return `${header}import type { SponsorDerivedCall } from "./policy.ts";

export const ${name}: readonly SponsorDerivedCall[] = [
${entries}
];
`;
}

export function renderFrameworkCalls(calls: readonly SponsorDerivedCall[]): string {
  return render(
    "SPONSOR_FRAMEWORK_CALLS",
    `// Generated by framework-calls.test.ts; do not edit. It lists the 0x1/0x2
// functions that SDK-built commits and Cetus aggregator sponsored-mode swaps
// call, for every way Sui sources the sender's coins. The policy requires
// exactly these argument and type-argument counts, an argument kind listed in
// \`argumentKinds\` at each position, and the sender at
// \`recipientArguments\`, and refuses any other address argument and any
// shared object. Regenerate with PRESALE_SPONSOR_FRAMEWORK_WRITE=1 and review.
`,
    calls,
  );
}

export function renderSwapCalls(calls: readonly SponsorDerivedCall[]): string {
  return render(
    "SPONSOR_SWAP_CALLS",
    `// Generated by framework-calls.test.ts; do not edit. It lists, as
// module::function, the Cetus aggregator functions that sponsored-mode
// swap-and-commit and fastRouterSwap({ sponsored: true }) call for every
// offline-buildable provider and coin source, over two route pools. A
// configured swap-target module admits only these functions, with exactly
// these argument and type-argument counts and, at each position, an argument
// kind listed in \`argumentKinds\`. \`recipientArguments\` must hold the
// sender and \`fixedArguments\` the derived address; any other address argument
// is refused. \`sharedObjects\` are the only positions that may take a shared
// object: a pinned \`objectId\` (a Partner, a config, the clock) must match, and
// \`null\` marks the route's pool, which the derivation enforces and which stays
// unconstrained (accepted residual B-005). Regenerate with PRESALE_SPONSOR_FRAMEWORK_WRITE=1 and review.
`,
    calls,
  );
}
