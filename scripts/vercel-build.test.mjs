import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Vercel builds release targets without running database migrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blast-vercel-build-"));
  try {
    const config = JSON.parse(await readFile(new URL("../apps/web/vercel.json", import.meta.url), "utf8"));
    // The documented release sequence (docs/deploy/BUILD-MEMORY.md): partner-live unit
    // tests, the app build, then the compiled-candidate partner gate. Never a migration.
    await writeFile(join(directory, "npm"), `#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
assert.ok(!args.some((arg) => /migrat/.test(arg)), args.join(" "));
appendFileSync(${JSON.stringify(join(directory, "calls"))}, JSON.stringify(args) + "\\n");
if (args[1] === "build") console.log("app build started");
`, { mode: 0o700 });
    for (const target of ["preview", "production"]) {
      const result = spawnSync("sh", ["-c", config.buildCommand], {
        cwd: fileURLToPath(new URL("../apps/web/", import.meta.url)),
        env: {
          ...process.env,
          VERCEL_ENV: target,
          VERCEL_GIT_COMMIT_REF: "develop",
          DATABASE_MIGRATION_URL: "",
          DATABASE_URL: "postgresql://blast_app:fixture@ep-fixture-pooler.c-12.us-east-1.aws.neon.tech/neondb?sslmode=require",
          PATH: `${directory}:${process.env.PATH}`,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /app build started/);
      const calls = (await readFile(join(directory, "calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(calls, [["run", "test:partner-live"], ["run", "build"], ["run", "check:partner-live", "--", "--built"]]);
      await rm(join(directory, "calls"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
