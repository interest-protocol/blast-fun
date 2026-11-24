import assert from "node:assert/strict";
import test from "node:test";

import { isSecretName, recordPresaleMetric, redactPresaleFields, redactPresaleText, REDACTED } from "./redaction.ts";

/**
 * T-008 (AC-105): no presale log line, metric label or error body carries a
 * private key, a Privy token, an API key, a gas-pool token, a user signature
 * or full CSV content.
 */

const PRIVATE_KEY = "suiprivkey1qzdlfxn2qa2lj5uprl8pyhexs02sg2wrhdy7qaq50cqgnffw4c2477kg9h";
const PRIVY_TOKEN =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkaWQ6cHJpdnk6YWJjIiwiaXNzIjoicHJpdnkuaW8ifQ.MEUCIQDx1y2z3a4b5c6d7e8f9g0h1i2j3k4l5m6n7o8p9q0r";
const USER_SIGNATURE = Buffer.alloc(97, 7).toString("base64");
const CSV = "wallet,cap\n0x" + "1".repeat(64) + ",100\n0x" + "2".repeat(64) + ",250\n";
const ADDRESS = `0x${"ab".repeat(32)}`;
const DIGEST = "5uhRGwvhv4Wbk1JTEnRUhVXN3ULpUPfcDvjXKHfrSjNx";

test("free text loses each secret class and keeps public identifiers", () => {
  const text = redactPresaleText(
    `key ${PRIVATE_KEY} auth Bearer agent-key-123 jwt ${PRIVY_TOKEN} basic Basic YXBwOnNlY3JldA== sig ${USER_SIGNATURE} wallet ${ADDRESS} digest ${DIGEST}`,
  );
  for (const secret of [PRIVATE_KEY, "agent-key-123", PRIVY_TOKEN, "YXBwOnNlY3JldA==", USER_SIGNATURE]) {
    assert.equal(text.includes(secret), false, secret.slice(0, 16));
  }
  assert.ok(text.includes(ADDRESS) && text.includes(DIGEST), "addresses and digests are public");
  assert.equal(redactPresaleText(CSV), REDACTED, "multi-line CSV content is never logged");
  assert.equal(redactPresaleText("wallet,cap"), "wallet,cap", "a header alone is not CSV content");
});

test("fields named for a secret are dropped whatever their value, at any depth", () => {
  const redacted = redactPresaleFields({
    route: "POST /api/presale/sponsor",
    status: 503,
    authorization: "Bearer anything",
    apiKey: "blast-agent-key",
    "x-api-key": "blast-agent-key",
    gasPoolToken: "gas-pool-bearer",
    gas_pool_token: "gas-pool-bearer",
    privateKey: "00".repeat(32),
    user_signature: "short",
    sponsor_signature: "short",
    access_token: "opaque",
    csv: "wallet,cap",
    nested: { file: CSV, cookie: "__Host-blast_vid=1", reason: "dry_run_failed", list: [PRIVY_TOKEN, "ok"] },
    wallet: ADDRESS,
  });
  assert.deepEqual(redacted, {
    route: "POST /api/presale/sponsor",
    status: 503,
    authorization: REDACTED,
    apiKey: REDACTED,
    "x-api-key": REDACTED,
    gasPoolToken: REDACTED,
    gas_pool_token: REDACTED,
    privateKey: REDACTED,
    user_signature: REDACTED,
    sponsor_signature: REDACTED,
    access_token: REDACTED,
    csv: REDACTED,
    nested: { file: REDACTED, cookie: REDACTED, reason: "dry_run_failed", list: [REDACTED, "ok"] },
    wallet: ADDRESS,
  });
});

test("presale metrics are written already redacted", () => {
  const lines: string[] = [];
  const original = console.info;
  const previous = process.env.MISSION_CONTROL_METRICS;
  delete process.env.MISSION_CONTROL_METRICS;
  console.info = (line: string) => void lines.push(line);
  try {
    recordPresaleMetric("presale.route", { outcome: "error", token: PRIVY_TOKEN, note: `Bearer ${PRIVY_TOKEN}` });
  } finally {
    console.info = original;
    if (previous !== undefined) process.env.MISSION_CONTROL_METRICS = previous;
  }
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(line.metric, "presale.route");
  assert.equal(line.outcome, "error");
  assert.doesNotMatch(lines[0], /eyJ/);
});

test("named secrets in free text and keystore keys are redacted (B-002)", () => {
  // A `sui keytool` / keystore entry: base64 of the flag byte and the 32-byte key.
  for (const flag of [0, 1, 2]) {
    const keystore = Buffer.concat([Buffer.from([flag]), Buffer.alloc(32, 0xfd)]).toString("base64");
    const text = redactPresaleText(`loaded key ${keystore} for the worker`);
    assert.equal(text.includes(keystore), false, `flag ${flag}`);
    assert.equal(text, `loaded key ${REDACTED} for the worker`);
  }
  const hexKey = `0x${"9c".repeat(32)}`;
  for (const [line, secret] of [
    [`privateKey=${hexKey}`, hexKey],
    [`private_key: ${hexKey}`, hexKey],
    ["x-api-key: blast_live_abc123", "blast_live_abc123"],
    ["X-API-Key=blast_live_abc123", "blast_live_abc123"],
    ["GAS_POOL_AUTH_TOKEN=gp_9f8e7d6c5b4a", "gp_9f8e7d6c5b4a"],
    ['{"gasPoolAuth":"gp_9f8e7d6c5b4a","status":503}', "gp_9f8e7d6c5b4a"],
    ["PRIVY_APP_SECRET='s3cr3t-value'", "s3cr3t-value"],
    ["user_signature=AKt0c2lnbmF0dXJl", "AKt0c2lnbmF0dXJl"],
  ] as const) {
    const text = redactPresaleText(`config error: ${line} (retrying)`);
    assert.equal(text.includes(secret), false, line);
    assert.ok(text.includes(REDACTED), line);
  }
  // Public names and values stay.
  const publicLine = `wallet=${ADDRESS} digest: ${DIGEST} keyId=key-7 author=pilot status=503 https://node.example:443/path`;
  assert.equal(redactPresaleText(publicLine), publicLine);
  assert.deepEqual(redactPresaleFields({ gasPoolAuth: "gp_x", authHeader: "x", author: "pilot", keyId: "key-7", publicKey: "pk" }), {
    gasPoolAuth: REDACTED,
    authHeader: REDACTED,
    author: "pilot",
    keyId: "key-7",
    publicKey: "pk",
  });
});

test("plural and abbreviated secret names are secrets (Q-009)", () => {
  for (const name of [
    "apiKeys",
    "api_keys",
    "accessTokens",
    "gasPoolTokens",
    "userSignatures",
    "secrets",
    "passwords",
    "cookies",
    "privKey",
    "priv_key",
    "privateKeys",
    "RATE_LIMIT_SUBJECT_PEPPER",
    "privyJwt",
  ]) {
    assert.equal(isSecretName(name), true, name);
    assert.deepEqual(redactPresaleFields({ [name]: ["blast_ak_live_123"] }), { [name]: REDACTED }, name);
    const text = redactPresaleText(`${name}=blast_ak_live_123 next`);
    assert.equal(text, `${name}=${REDACTED} next`, name);
  }
});

test("presale-domain names and labelled digests stay public (Q-010)", () => {
  for (const name of [
    "token_bps",
    "tokenType",
    "token_amount",
    "tokens",
    "auth",
    "authMode",
    "privateSale",
    "isPrivate",
    "signatureScheme",
    "csvRows",
    "author",
    "keyId",
    "publicKey",
  ]) {
    assert.equal(isSecretName(name), false, name);
  }
  assert.equal(redactPresaleText("fee token_bps=250 auth: account"), "fee token_bps=250 auth: account");
  const digest = `A${"7".repeat(43)}`;
  for (const line of [`digest: ${digest}`, `{"digest":"${digest}"}`, `tx_digest=${digest}`, `checkpoint_digest ${digest}`]) {
    assert.equal(redactPresaleText(line), line, line);
  }
  // Unlabelled, or not base58, it is treated as a keystore key.
  assert.equal(redactPresaleText(`loaded ${digest}`), `loaded ${REDACTED}`);
  const keystore = Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 0xfb)]).toString("base64");
  assert.equal(redactPresaleText(`digest: ${keystore}`), `digest: ${REDACTED}`, "+ and / are not base58");
});

test("escaped JSON and CLI flags lose their secrets, and redaction leaves no stray bracket (B-008, Q-011)", () => {
  const hexKey = `0x${"9c".repeat(32)}`;
  const doubly = JSON.stringify(JSON.stringify({ privateKey: hexKey, apiKey: "blast_ak_live_123", wallet: ADDRESS }));
  const redacted = redactPresaleText(`provider said ${doubly}`);
  assert.equal(redacted.includes(hexKey) || redacted.includes("blast_ak_live_123"), false, redacted);
  assert.ok(redacted.includes(ADDRESS));
  for (const [line, secret] of [
    [`sui keytool import --private-key ${hexKey} ed25519`, hexKey],
    ["worker --api-key=blast_ak_live_123 --verbose", "blast_ak_live_123"],
    ["run --gas-pool-token gp_9f8e7d6c5b4a", "gp_9f8e7d6c5b4a"],
  ] as const) {
    const text = redactPresaleText(line);
    assert.equal(text.includes(secret), false, line);
  }
  assert.equal(redactPresaleText("run --network mainnet --verbose"), "run --network mainnet --verbose");
  assert.equal(redactPresaleText("Authorization: Basic YXBwOnNlY3JldA=="), `Authorization: ${REDACTED}`);
  assert.equal(redactPresaleText(`authorization: Bearer ${"x".repeat(20)}`), `authorization: ${REDACTED}`);
});

test("an agent API key is redacted wherever it appears in free text (T-013, AC-063)", () => {
  const key = `blast_ak_${"Zx9_-".repeat(8)}abc`;
  assert.match(key, /^blast_ak_[A-Za-z0-9_-]{43}$/);
  for (const line of [`agent sent ${key} twice`, `"${key}"`, `header=${key}`, `${key}.`]) {
    const text = redactPresaleText(line);
    assert.equal(text.includes(key), false, line);
    assert.ok(text.includes(REDACTED), line);
  }
  assert.equal(redactPresaleText("blast_ak_ is the key prefix"), "blast_ak_ is the key prefix");
});
