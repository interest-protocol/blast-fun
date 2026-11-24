import assert from "node:assert/strict";
import test from "node:test";

import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { readAllowlistUpload } from "./upload.ts";

/**
 * T-013 (AC-049..AC-051): an allowlist upload, CSV (multipart) or JSON, read
 * from the request into ordered entries, or refused with the published code.
 */

const USDC = `0x${"d".repeat(64)}::usdc::USDC`;
const A = `0x${"a".repeat(64)}`;
const B = `0x${"b".repeat(64)}`;

function csvUpload(csv: string | Uint8Array<ArrayBuffer>, fields: Record<string, string> = { quote: USDC }): Request {
  const form = new FormData();
  form.set("file", new Blob([csv], { type: "text/csv" }), "allowlist.csv");
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return new Request("https://blast.fun/api/presale/allowlists", { method: "POST", body: form });
}

function jsonUpload(body: unknown): Request {
  return new Request("https://blast.fun/api/presale/allowlists", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The refusal `upload` ends in: its code and, for invalid_allowlist, its rows. */
async function refusal(upload: Request): Promise<{ code: string; rows?: unknown }> {
  try {
    await readAllowlistUpload(upload);
  } catch (error) {
    assert.ok(error instanceof PresaleRouteError, String(error));
    return { code: error.code, ...(error.extra.rows ? { rows: error.extra.rows } : {}) };
  }
  assert.fail("the upload was accepted");
}

test("a CSV upload gives ordered, normalized entries; a short address is padded with a warning", async () => {
  const csv = "﻿ Wallet , CAP \r\n" + `${A},5000000000\r\n` + "0xB0B,18446744073709551615\r\n";
  const upload = await readAllowlistUpload(csvUpload(csv));
  assert.deepEqual(upload, {
    fileName: "allowlist.csv",
    includeBlastHolders: false,
    quote: USDC,
    entries: [
      { wallet: A, walletCap: 5_000_000_000n },
      { wallet: `0x${"0".repeat(61)}b0b`, walletCap: 18_446_744_073_709_551_615n },
    ],
    warnings: [{ code: "normalized_address", message: "Row 2's address was left-padded to 64 hex characters.", row: 2 }],
  });
});

test("each invalid-row class is reported with its data row number and reason", async () => {
  const csv = [
    "wallet,cap",
    `${A},100`, // 1: valid
    "0xnothex,100", // 2
    `${A.slice(2)},100`, // 3: no 0x
    `0x${"1".repeat(65)},100`, // 4: too long
    `${B},0`, // 5
    `0x${"c".repeat(64)},-3`, // 6
    `0x${"e".repeat(64)},1.5`, // 7
    `0x${"f".repeat(64)},18446744073709551616`, // 8: u64 max + 1
    `0x${"A".repeat(64)},7`, // 9: duplicate of row 1 after normalization
    "0x00b,1", // 10
    "0xb,2", // 11: duplicate of row 10 after padding
    `0x${"9".repeat(64)},1,extra`, // 12
    "", // 13: an empty line that is not the last
    "bad,", // 14: invalid address and missing cap
    "",
  ].join("\n");
  assert.deepEqual(await refusal(csvUpload(csv)), {
    code: "invalid_allowlist",
    rows: [
      { row: 2, reason: "invalid address" },
      { row: 3, reason: "invalid address" },
      { row: 4, reason: "invalid address" },
      { row: 5, reason: "cap must be at least 1" },
      { row: 6, reason: "cap must be at least 1" },
      { row: 7, reason: "cap must be a base-10 integer" },
      { row: 8, reason: "cap exceeds the u64 maximum" },
      { row: 9, reason: "duplicate wallet (first on row 1)" },
      { row: 11, reason: "duplicate wallet (first on row 10)" },
      { row: 12, reason: "a row needs exactly a wallet and a cap" },
      { row: 13, reason: "a row needs exactly a wallet and a cap" },
      { row: 14, reason: "invalid address" },
      { row: 14, reason: "cap must be a base-10 integer" },
    ],
  });
});

test("row errors stop at the first 100", async () => {
  const csv = ["wallet,cap", ...Array.from({ length: 250 }, () => "0xzz,1")].join("\n");
  const { rows } = await refusal(csvUpload(csv));
  assert.equal((rows as unknown[]).length, 100);
  assert.deepEqual((rows as { row: number }[]).at(-1), { row: 100, reason: "invalid address" });
});

test("a JSON upload validates its entries like CSV rows", async () => {
  const upload = await readAllowlistUpload(jsonUpload({ quote: USDC, entries: [{ wallet: A, cap: "1" }, { wallet: "0x2", cap: "2" }] }));
  assert.deepEqual(upload.entries, [
    { wallet: A, walletCap: 1n },
    { wallet: `0x${"0".repeat(63)}2`, walletCap: 2n },
  ]);
  assert.deepEqual(upload.warnings.map((warning) => warning.row), [2]);
  assert.deepEqual(
    await refusal(jsonUpload({ quote: USDC, entries: [{ wallet: A, cap: 1 }, { wallet: B }, "x", { wallet: 7, cap: "1", note: 1 }] })),
    {
      code: "invalid_allowlist",
      rows: [
        { row: 1, reason: "cap must be a base-10 integer string" },
        { row: 2, reason: "a row needs exactly a wallet and a cap" },
        { row: 3, reason: "a row needs exactly a wallet and a cap" },
        { row: 4, reason: "a row needs exactly a wallet and a cap" },
      ],
    },
  );
});

test("a malformed body, header, quote or an empty list is invalid_request", async () => {
  const valid = `wallet,cap\n${A},1\n`;
  for (const upload of [
    csvUpload(`address,cap\n${A},1\n`),
    csvUpload(`wallet;cap\n${A};1\n`),
    csvUpload("wallet,cap\n"),
    csvUpload(""),
    csvUpload(Uint8Array.from([0x77, 0x61, 0xff, 0x0a])),
    csvUpload(valid, {}),
    csvUpload(valid, { quote: "not a type" }),
    csvUpload(valid, { quote: USDC, extra: "1" }),
    jsonUpload({ quote: USDC, entries: [] }),
    jsonUpload({ quote: USDC }),
    jsonUpload({ quote: USDC, entries: {}, other: 1 }),
    jsonUpload({ quote: 1, entries: [{ wallet: A, cap: "1" }] }),
    jsonUpload([1]),
    new Request("https://blast.fun/api/presale/allowlists", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
    new Request("https://blast.fun/api/presale/allowlists", { method: "POST", headers: { "content-type": "text/csv" }, body: valid }),
    new Request("https://blast.fun/api/presale/allowlists", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "garbage",
    }),
  ]) {
    assert.equal((await refusal(upload)).code, "invalid_request");
  }
  const form = new FormData();
  form.set("file", valid);
  form.set("quote", USDC);
  const stringFile = new Request("https://blast.fun/api/presale/allowlists", { method: "POST", body: form });
  assert.equal((await refusal(stringFile)).code, "invalid_request", "the CSV is a file part");
});

test("over 65,536 rows or a body over 4 MiB is allowlist_too_large", async () => {
  const rows = (count: number) => Array.from({ length: count }, (_, index) => `0x${(index + 1).toString(16)},1`);
  assert.equal((await readAllowlistUpload(csvUpload(["wallet,cap", ...rows(65_536)].join("\n")))).entries.length, 65_536);
  assert.equal((await refusal(csvUpload(["wallet,cap", ...rows(65_537)].join("\n")))).code, "allowlist_too_large");
  const entries = Array.from({ length: 65_537 }, () => ({ wallet: "0x1", cap: "1" }));
  assert.equal((await refusal(jsonUpload({ quote: USDC, entries }))).code, "allowlist_too_large");

  const limit = 4 * 1_024 * 1_024;
  const exact = (size: number) => {
    const prefix = `{"quote":"${USDC}","entries":[{"wallet":"${A}","cap":"1"}]}`;
    return new Request("https://blast.fun/api/presale/allowlists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: prefix + " ".repeat(size - prefix.length),
    });
  };
  assert.equal((await readAllowlistUpload(exact(limit))).entries.length, 1, "exactly 4 MiB is accepted");
  assert.equal((await refusal(exact(limit + 1))).code, "allowlist_too_large");
  const declared = new Request("https://blast.fun/api/presale/allowlists", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(limit + 1) },
    body: "{}",
  });
  assert.equal((await refusal(declared)).code, "allowlist_too_large", "a declared length over the limit is refused unread");
});

test("normalized_address warnings name the first 100 padded rows, then one summary item", async () => {
  const csv = ["wallet,cap", A, ...Array.from({ length: 65_535 }, (_, index) => `0x${(index + 1).toString(16)}`)]
    .map((wallet, index) => (index === 0 ? wallet : `${wallet},1`))
    .join("\n");
  const { entries, warnings } = await readAllowlistUpload(csvUpload(csv));
  assert.equal(entries.length, 65_536);
  assert.equal(warnings.length, 101);
  assert.deepEqual(warnings[0], { code: "normalized_address", message: "Row 2's address was left-padded to 64 hex characters.", row: 2 });
  assert.deepEqual(warnings[99], { code: "normalized_address", message: "Row 101's address was left-padded to 64 hex characters.", row: 101 });
  assert.deepEqual(warnings[100], { code: "normalized_address", message: "65435 more rows normalized" });
  assert.ok(JSON.stringify(warnings).length < 16_384, "the warnings stay small");

  const exactly100 = ["wallet,cap", ...Array.from({ length: 100 }, (_, index) => `0x${(index + 1).toString(16)},1`)].join("\n");
  const hundred = (await readAllowlistUpload(csvUpload(exactly100))).warnings;
  assert.equal(hundred.length, 100, "no summary when nothing is left over");
  assert.equal(hundred.every((warning) => warning.row !== undefined), true);
});

test("an oversized cap is refused by its length, before any number is parsed", async () => {
  const csv = (cap: string) => `wallet,cap\n${A},${cap}\n`;
  // Leading zeros are not significant: 20 significant digits up to u64 max are accepted.
  assert.equal((await readAllowlistUpload(csvUpload(csv(`000${"18446744073709551615"}`)))).entries[0].walletCap, 18_446_744_073_709_551_615n);
  assert.deepEqual(await refusal(csvUpload(csv("1".repeat(21)))), {
    code: "invalid_allowlist",
    rows: [{ row: 1, reason: "cap exceeds the u64 maximum" }],
  });
  const original = globalThis.BigInt;
  const parsed: number[] = [];
  globalThis.BigInt = ((value: string | number | bigint | boolean) => {
    if (typeof value === "string") parsed.push(value.length);
    return original(value);
  }) as BigIntConstructor;
  try {
    const huge = await refusal(csvUpload(csv("9".repeat(1_000_000))));
    assert.deepEqual(huge.rows, [{ row: 1, reason: "cap exceeds the u64 maximum" }]);
  } finally {
    globalThis.BigInt = original;
  }
  assert.equal(parsed.some((length) => length > 20), false, "a cap longer than 20 significant digits is never parsed");
});

test("card-holder inclusion is an explicit boolean opt-in", async () => {
  const entries = [{ wallet: A, cap: "100" }];
  assert.equal((await readAllowlistUpload(jsonUpload({ quote: USDC, entries }))).includeBlastHolders, false);
  assert.equal((await readAllowlistUpload(jsonUpload({ quote: USDC, entries, include_blast_holders: true }))).includeBlastHolders, true);
  assert.equal((await refusal(jsonUpload({ quote: USDC, entries, include_blast_holders: "true" }))).code, "invalid_request");
});
