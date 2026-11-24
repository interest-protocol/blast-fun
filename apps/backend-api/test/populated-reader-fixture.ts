import assert from "node:assert/strict";
import { closeSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const objectId = z.string().regex(/^0x[0-9a-f]{64}$/);
const u64 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n);
const origin = z.string().refine((value) => {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) {
    return false;
  }
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
});
const nativeCase = z.strictObject({
  id: z.string(),
  path: z.string(),
  body: z.record(z.string(), z.unknown()),
});

const fixtureSchema = z.strictObject({
  schema_version: z.literal(1),
  scenario: z.literal("presale-vault-v1"),
  nonce: z.string().regex(/^[0-9a-f]{32,128}$/),
  network: z.literal("mainnet"),
  deployment_fingerprint: hash,
  reader_origin: origin,
  writer_origin: origin,
  database_name: z.string().regex(/^blast_test_[0-9]+_[0-9]+_[0-9]+$/),
  source_revision: z.string().regex(/^[0-9a-f]{40}$/),
  source_diff_sha256: hash,
  executable_sha256: hash,
  fixture_module_sha256: hash,
  fixture_sha256: hash,
  final_checkpoint: u64,
  fixture_timestamp_ms: u64,
  producer_mode: z.enum([
    "debug-test-process-native-committed-reader",
    "release-process-native-committed-reader",
  ]),
  archival_freshness_override: z.strictObject({
    max_lag_ms: z.literal("18446744073709551615"),
    reason: z.literal("archival synthetic checkpoints; no live freshness claim"),
  }),
  ids: z.strictObject({
    presale_id: objectId,
    vault_id: objectId,
    pool_id: objectId,
    wallet: objectId,
    coin_type: z.string().regex(/^0x[0-9a-f]{64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/),
  }),
  cases: z.array(nativeCase).length(4),
  completion_file: z.string(),
});

export type PopulatedReaderFixture = z.infer<typeof fixtureSchema>;

export type PopulatedReaderBinding = Readonly<{
  nonce: string;
  source_revision: string;
  source_diff_sha256: string;
  executable_sha256: string;
  fixture_module_sha256: string;
}>;

/** The outer owner supplies source identities independently of the untrusted ready file. */
export function populatedReaderBinding(environment: NodeJS.ProcessEnv): PopulatedReaderBinding {
  const fields = {
    nonce: environment.BLAST_POPULATED_FIXTURE_NONCE,
    source_revision: environment.BLAST_POPULATED_FIXTURE_EXPECTED_SOURCE_REVISION,
    source_diff_sha256: environment.BLAST_POPULATED_FIXTURE_EXPECTED_SOURCE_DIFF_SHA256,
    executable_sha256: environment.BLAST_POPULATED_FIXTURE_EXPECTED_EXECUTABLE_SHA256,
    fixture_module_sha256: environment.BLAST_POPULATED_FIXTURE_EXPECTED_FIXTURE_MODULE_SHA256,
  };
  return fixtureSchema
    .pick({
      nonce: true,
      source_revision: true,
      source_diff_sha256: true,
      executable_sha256: true,
      fixture_module_sha256: true,
    })
    .parse(fields);
}

/** Only this finite native scenario is accepted; no legacy curve handoff is relaxed. */
export function parsePopulatedReaderFixture(
  value: unknown,
  binding: PopulatedReaderBinding,
  path: string,
): PopulatedReaderFixture {
  assert.ok(isAbsolute(path), "An absolute populated ready file is required.");
  const fixture = fixtureSchema.parse(value);
  for (const field of Object.keys(binding) as (keyof PopulatedReaderBinding)[]) {
    assert.equal(
      fixture[field],
      binding[field],
      `Populated fixture ${field} does not match the outer owner.`,
    );
  }
  assert.notEqual(
    fixture.reader_origin,
    fixture.writer_origin,
    "Reader and operations writer must be separate.",
  );
  assert.equal(fixture.completion_file, join(dirname(path), "completion.json"));
  assert.ok(BigInt(fixture.final_checkpoint) > 0n && BigInt(fixture.fixture_timestamp_ms) > 0n);
  const { presale_id: sale, wallet, vault_id: vault } = fixture.ids;
  assert.deepEqual(
    fixture.cases.map(({ id, path: route }) => [id, route]),
    [
      ["presale-detail", `/v1/presales/${sale}`],
      ["presale-commitments", `/v1/presales/${sale}/commitments?limit=2`],
      ["presale-wallet", `/v1/presales/${sale}/wallets/${wallet}`],
      ["vault-detail", `/v1/vaults/${vault}`],
    ],
  );
  return fixture;
}

/** A bounded read also rejects a growing file without allocating its claimed size. */
export function readPopulatedReaderFixture(
  path: string | undefined,
  binding: PopulatedReaderBinding,
): PopulatedReaderFixture {
  assert.ok(path && isAbsolute(path), "An absolute populated ready file is required.");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(1_048_577);
  try {
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    assert.ok(length > 0 && length <= 1_048_576, "Populated ready file must fit within 1 MiB.");
    return parsePopulatedReaderFixture(
      JSON.parse(buffer.subarray(0, length).toString("utf8")),
      binding,
      path,
    );
  } finally {
    closeSync(descriptor);
  }
}
