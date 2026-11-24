// Mutation testing for one module at a time (StrykerJS, tap runner over node:test).
// Not part of the gate. Use it to check that a module's tests catch real breaks.
//
//   MUTATE_TESTS="packages/server/src/a.test.ts packages/server/src/b.test.ts" \
//     npx --no-install stryker run --mutate 'packages/server/src/a.ts,packages/core/src/x.ts'
//
// MUTATE_TESTS: the module's test files, space separated, all from one hook family below.
// MUTATE_SKIP:  optional, a --test-skip-pattern regex; compare survivors with and without it
//               to see what one test adds (see the efficient-tests skill).
// Reports land in reports/mutation/ (html and mutation.json). Run from the repository root.
//
// Choices:
// - inPlace: tests reach other packages through node_modules links (@blast/core ->
//   packages/core). In a sandbox copy those links still point at the unmutated originals,
//   so every packages/core mutant showed "no coverage" there. Mutants are written into
//   the working tree and restored at the end: run it in a task worktree, and if a run is
//   killed, `git checkout` the mutated files.
// - --test-isolation=none: node --test otherwise runs each file in a child process that
//   Stryker's coverage hook cannot see, and every mutant then reads "no coverage".
// - Kills are reported per test file (the tap runner's granularity), not per test.
// - Bun tests (apps/backend-api) are not supported.
const tests = (process.env.MUTATE_TESTS ?? "").split(/\s+/).filter(Boolean);
if (!tests.length) throw new Error("Set MUTATE_TESTS to the module's test files (space separated).");

// Same --import hook each package's `npm test` uses (root scripts/ tests take the web one).
const HOOKS = [
  [/^(apps\/web|packages\/core|scripts)\//, "./scripts/test-tsx-hooks.mjs"],
  [/^(apps\/workers|packages\/server)\//, "./scripts/register-runtime-types.mjs"],
];
const hookOf = (file) => {
  const found = HOOKS.find(([prefix]) => prefix.test(file));
  if (!found) throw new Error(`No node:test hook for ${file} (Bun tests in apps/backend-api are not supported).`);
  return found[1];
};
const hooks = new Set(tests.map(hookOf));
if (hooks.size > 1) throw new Error(`MUTATE_TESTS mixes hook families (${[...hooks].join(", ")}); run them separately.`);

export default {
  testRunner: "tap",
  inPlace: true,
  coverageAnalysis: "perTest",
  // Node strips types without checking them, so Stryker need not add // @ts-nocheck
  // (in place, that rewrite also dropped the executable bit of untouched scripts).
  disableTypeChecks: false,
  concurrency: 2,
  timeoutMS: 60000,
  reporters: ["clear-text", "progress", "html", "json"],
  tap: {
    testFiles: tests,
    nodeArgs: [
      "--no-warnings",
      "--import",
      [...hooks][0],
      "--experimental-strip-types",
      "-r",
      "{{hookFile}}",
      "--test",
      // Run the file in this process, so Stryker's hook sees which test reached each mutant.
      "--test-isolation=none",
      "--test-reporter=tap",
      ...(process.env.MUTATE_SKIP ? [`--test-skip-pattern=${process.env.MUTATE_SKIP}`] : []),
      "{{testFile}}",
    ],
  },
};
