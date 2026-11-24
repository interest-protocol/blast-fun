import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { blankDraft } from "@blast/core/modules/social/create/model.ts";
import { recipientRecoveryFile } from "./recovery-file.ts";

test("offline recovery emits a canonical envelope bound to all original UTF-8 source bytes", () => {
  const old = {
    label: "Team",
    address: "",
    bps: 0,
    vest: false,
    cliff_months: 3,
    months: 12,
  };
  const body = {
    ...blankDraft(),
    token_recipients: [old],
    raise_recipients: [old],
  };
  const source = Buffer.from(`  ${JSON.stringify(body)}\n`, "utf8");
  const before = Buffer.from(source);
  const envelope = JSON.parse(recipientRecoveryFile(source));
  assert.equal(envelope.schema, "blast.social-create-guest-draft");
  assert.equal(envelope.version, 1);
  assert.equal(
    envelope.recovered_from,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.notEqual(
    envelope.recovered_from,
    createHash("sha256").update(source.toString().trim()).digest("hex"),
  );
  assert.deepEqual(envelope.draft.token_recipients, [
    {
      label: "Team",
      address: "",
      bps: 0,
      vest: false,
      cliff: 3,
      duration: 12,
      cliff_unit: "months",
      duration_unit: "months",
    },
  ]);
  assert.deepEqual(
    envelope.draft.raise_recipients,
    envelope.draft.token_recipients,
  );
  assert.deepEqual(source, before);
  assert.deepEqual(Object.keys(envelope).sort(), [
    "draft",
    "recovered_from",
    "schema",
    "version",
  ]);
});

test("offline JSON decoding refuses rounded fractional or underflowed numbers before normalizing", () => {
  const draft = { ...blankDraft(), token_recipients: [
    { label: "Team", address: "", bps: 0, vest: false, cliff_months: 3, months: 12 },
  ] };
  const raw = JSON.stringify(draft);
  for (const token of ["9007199254740990.5", "9007199254740991.1", "1e-400", "1e999"]) {
    const source = Buffer.from(raw.replace('"cliff_months":3', `"cliff_months":${token}`));
    const before = Buffer.from(source);
    assert.throws(() => recipientRecoveryFile(source), /recipient_recovery_invalid/);
    assert.deepEqual(source, before);
  }
  for (const token of ["9007199254740991", "100e-2", "3.000", "0e-999999999999999999999"]) {
    const source = Buffer.from(raw.replace('"cliff_months":3', `"cliff_months":${token}`));
    const recovered = JSON.parse(recipientRecoveryFile(source));
    assert.equal(recovered.draft.token_recipients[0].cliff, Number(token));
  }
});

test("offline CLI preserves its source, writes a private canonical file and never clobbers an existing output", () => {
  const directory = mkdtempSync(join(tmpdir(), "blast-recipient-cli-"));
  const source = join(directory, "synthetic-source.json");
  const output = join(directory, "synthetic-recovered.json");
  const input = ` ${JSON.stringify(blankDraft())}\n`;
  const loader = fileURLToPath(
    new URL("../../test-tsx-hooks.mjs", import.meta.url),
  );
  const entry = fileURLToPath(new URL("./recover.ts", import.meta.url));
  const run = () =>
    execFileSync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        loader,
        "--experimental-strip-types",
        entry,
        source,
        output,
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        stdio: "pipe",
        timeout: 15_000,
      },
    );
  try {
    writeFileSync(source, input, { mode: 0o600 });
    const report = JSON.parse(run());
    assert.equal(report.status, "prepared");
    assert.equal(
      report.source_sha256,
      createHash("sha256").update(input).digest("hex"),
    );
    const prepared = readFileSync(output, "utf8");
    assert.equal(JSON.parse(prepared).recovered_from, report.source_sha256);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(readFileSync(source, "utf8"), input);
    assert.throws(run);
    assert.equal(readFileSync(output, "utf8"), prepared);
    assert.equal(readFileSync(source, "utf8"), input);
    rmSync(output);
    writeFileSync(source, "{private-marker");
    assert.throws(
      run,
      (error) =>
        error instanceof Error &&
        !String((error as { stderr?: unknown }).stderr).includes(
          "private-marker",
        ),
    );
    assert.equal(existsSync(output), false);
    assert.equal(readFileSync(source, "utf8"), "{private-marker");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline recovery refuses malformed JSON, invalid UTF-8 and ambiguous rows with sanitized diagnostics", () => {
  const ambiguous = {
    ...blankDraft(),
    token_recipients: [
      {
        label: "private-marker",
        address: "",
        bps: 0,
        vest: false,
        cliff_months: 3,
        months: 12,
        duration: 12,
      },
    ],
  };
  for (const source of [
    Buffer.from("{private-marker"),
    new Uint8Array([0xc3, 0x28]),
    Buffer.from(JSON.stringify(ambiguous)),
  ]) {
    assert.throws(
      () => recipientRecoveryFile(source),
      (error) =>
        error instanceof Error && !error.message.includes("private-marker"),
    );
  }
});
