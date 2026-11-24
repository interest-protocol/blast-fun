import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { once } from "node:events";

const root = new URL("../", import.meta.url);
const scratch = await mkdtemp(join(tmpdir(), "blast-dashboard-artifact-"));
let child;
try {
  // No source checkout, workspace packages, parent dependencies, provider adapter or credentials.
  await Promise.all(
    [
      "package.json",
      "package-lock.json",
      "src",
      "public",
      "generated",
      "scripts",
      "node_modules",
    ].map((entry) =>
      cp(new URL(entry, root), join(scratch, entry), {
        recursive: true,
        dereference: true,
      }),
    ),
  );
  assert.doesNotMatch(
    await readFile(join(scratch, "src/handler.ts"), "utf8"),
    /\.\.\/\.\.\//,
  );
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  child = spawn(process.execPath, ["scripts/prepare.mjs"], {
    cwd: scratch,
    stdio: "pipe",
    env: { PATH: process.env.PATH },
  });
  let output = "";
  child.stdout.on("data", (value) => {
    output += value;
  });
  child.stderr.on("data", (value) => {
    output += value;
  });
  assert.equal((await once(child, "exit"))[0], 0, output);
  child = spawn(process.execPath, ["src/server.ts"], {
    cwd: scratch,
    stdio: "pipe",
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      PORT: String(port),
      ANALYTICS_DASHBOARD_ORIGIN: `http://127.0.0.1:${port}`,
      ANALYTICS_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
      ANALYTICS_API_URL: "http://127.0.0.1:1",
      ANALYTICS_API_TOKEN: "artifact-fixture-token-32-characters",
      ANALYTICS_ACCESS_DATABASE_URL:
        "postgres://disposable@127.0.0.1:1/no_database",
    },
  });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/live`);
      assert.equal(response.status, 200);
      break;
    } catch {
      assert.ok(Date.now() < deadline, "Standalone server must start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const signIn = await fetch(`http://127.0.0.1:${port}/`);
  if (signIn.status !== 200)
    throw new Error("Standalone sign-in must return 200");
  assert.match(await signIn.text(), /One-time code/);
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/api/summary`)).status,
    401,
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/generated/aggregate-contract.ts`))
      .status,
    401,
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/fonts/geist.woff2`)).status,
    200,
  );
  console.log(
    "PASS: isolated prepared artifact starts and gates private content without workspace paths or a database",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  await rm(scratch, { recursive: true, force: true });
}
