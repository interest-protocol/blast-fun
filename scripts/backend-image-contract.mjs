import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const expected =
  "error: BLAST_REDIS_NAMESPACE must identify the network, deployment and environment.";

/** Static production imports must finish before the intentional config refusal. */
export function assertImageStartup(status, output) {
  assert.equal(
    status,
    1,
    "The image must exit through the expected configuration refusal.",
  );
  const errors = output
    .split("\n")
    .filter((line) => /^(?:\w*Error(?: \[[^\]]+\])?|error):/.test(line));
  assert.deepEqual(
    errors,
    [expected],
    "Only the exact production configuration error is accepted; import and native-module errors fail.",
  );
  assert.match(
    output,
    /(?:^|\n)Bun v1\.4\.2 \(Linux (?:x64|arm64)\)(?:\n|$)/,
    "The exact native Bun runtime must report the refusal.",
  );
  assert.ok(
    !/backend[^\n]*listening/i.test(output),
    "An unconfigured backend must not listen.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [image, logPath] = process.argv.slice(2);
  assert.ok(
    image && logPath,
    "Usage: node scripts/backend-image-contract.mjs IMAGE LOG_PATH",
  );
  const name = `blast-backend-image-contract-${process.pid}`;
  try {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--cpus",
        "1",
        "--memory",
        "512m",
        "--memory-swap",
        "512m",
        "--tmpfs",
        "/tmp:size=16m",
        image,
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    writeFileSync(logPath, output);
    if (result.error) throw result.error;
    assertImageStartup(result.status, output);
    console.log(
      "Pinned Bun production imports resolved; exact missing-configuration refusal verified without network access.",
    );
  } finally {
    spawnSync("docker", ["rm", "--force", name], {
      stdio: "ignore",
      timeout: 10_000,
    });
  }
}
