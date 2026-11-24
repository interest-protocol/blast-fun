import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url)));
const zodPackages = Object.keys(lock.packages).filter((path) => path.endsWith("node_modules/zod"));

for (const path of zodPackages) {
  for (const entry of ["index.js", "index.cjs"]) {
    test(`${path}/${entry} rejects oversized collections before parsing elements`, async () => {
      const modulePath = resolve(root, path, entry);
      const z = entry.endsWith(".cjs")
        ? require(modulePath)
        : await import(pathToFileURL(modulePath));
      await assertCollectionBounds(z);
    });
  }
}

const backport = zodPackages.find((path) => lock.packages[path].name === "@blast/zod-v3");
assert.ok(backport, "SDKs must use the reviewed Zod 3 security backport");

test("Cetus's installed Hermes client validates price feeds and rejects malformed prices", async (t) => {
  const sdkRequire = createRequire(require.resolve("@cetusprotocol/aggregator-sdk"));
  const { HermesClient } = sdkRequire("@pythnetwork/hermes-client");
  const id = "ab".repeat(32);
  const feeds = [{ id, attributes: { symbol: "SUI/USD", asset_type: "Crypto" } }];
  const price = { price: "12345", conf: "10", expo: -4, publish_time: 1_700_000_000 };
  let prices = {
    binary: { data: ["abcdef"], encoding: "hex" },
    parsed: [{ id, price, ema_price: price, metadata: { slot: 123 } }],
  };
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push(url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(url.pathname === "/v2/price_feeds" ? feeds : prices));
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new HermesClient(`http://127.0.0.1:${server.address().port}`, {
    httpRetries: 0,
    timeout: 2_000,
  });

  assert.deepEqual(await client.getPriceFeeds({ query: "SUI" }), feeds);
  assert.deepEqual(
    await client.getLatestPriceUpdates([id], { encoding: "hex", parsed: true }),
    prices,
  );
  assert.equal(requests[0].searchParams.get("query"), "SUI");
  assert.deepEqual(requests[1].searchParams.getAll("ids[]"), [id]);
  prices = { binary: { data: [123], encoding: "hex" } };
  await assert.rejects(client.getLatestPriceUpdates([id]), (error) => error.name === "ZodError");
});

for (const version of ["v3", "v4"]) {
  for (const entry of ["index.js", "index.cjs"]) {
    test(`backport ${version}/${entry} preserves collection validation`, async () => {
      const modulePath = resolve(root, backport, version, entry);
      const z = entry.endsWith(".cjs")
        ? require(modulePath)
        : await import(pathToFileURL(modulePath));
      await assertCollectionBounds(z);
    });
  }
}

for (const entry of ["index.js", "index.cjs"]) {
  test(`backport mini/${entry} rejects oversized arrays, sets and maps`, async () => {
    const modulePath = resolve(root, backport, "v4-mini", entry);
    const z = entry.endsWith(".cjs")
      ? require(modulePath)
      : await import(pathToFileURL(modulePath));
    let visited = 0;
    const element = z.string().check(
      z.check(() => {
        visited++;
      }),
    );
    for (const [schema, input] of [
      [z.array(element).check(z.maxLength(1)), ["a", "b"]],
      [z.set(element).check(z.maxSize(1)), new Set(["a", "b"])],
      [
        z.map(element, element).check(z.size(1)),
        new Map([
          ["a", "b"],
          ["c", "d"],
        ]),
      ],
    ]) {
      assert.equal(z.safeParse(schema, input).success, false);
      assert.equal((await z.safeParseAsync(schema, input)).success, false);
      assert.equal(visited, 0);
    }
    const conditional = z.array(z.string()).check(z.maxLength(1, { when: () => false }));
    assert.equal(z.safeParse(conditional, ["a", "b"]).success, true);
    assert.equal(z.safeParse(conditional, [1, 2]).success, false);
  });
}

async function assertCollectionBounds(z) {
  let visited = 0;
  const element = z.string().transform((value) => {
    visited++;
    return value.toUpperCase();
  });
  const cases = [
    [z.array(element).max(1), ["a", "b"]],
    [z.array(element).length(1), ["a", "b"]],
    [z.array(element).max(0), ["a"]],
    [z.set(element).max(1), new Set(["a", "b"])],
    [z.set(element).size(1), new Set(["a", "b"])],
  ];
  if (z.maxSize) {
    cases.push([
      z.map(element, element).check(z.maxSize(1)),
      new Map([
        ["a", "b"],
        ["c", "d"],
      ]),
    ]);
  }

  for (const [schema, input] of cases) {
    const result = schema.safeParse(input);
    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].code, "too_big");
    assert.equal(visited, 0, "oversized input must not invoke element parsers");
    assert.equal((await schema.safeParseAsync(input)).success, false);
    assert.equal(visited, 0, "async parsing must also reject before walking elements");
  }

  for (const [schema, input] of [
    [z.array(element).max(1), new Set(["a", "b"])],
    [z.set(element).max(1), ["a", "b"]],
    ...(z.maxSize ? [[z.map(element, element).check(z.maxSize(1)), new Set(["a", "b"])]] : []),
  ]) {
    const result = schema.safeParse(input);
    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].code, "invalid_type");
  }

  if (typeof z.array(z.number()).overwrite === "function") {
    assert.deepEqual(
      z
        .array(z.number())
        .overwrite((values) => values.slice(0, 1))
        .max(1)
        .parse([1, 2]),
      [1],
      "a size check after a value rewrite must inspect the rewritten collection",
    );
  }

  const refined = z
    .array(element)
    .max(1)
    .optional()
    .superRefine(() => {
      assert.fail("oversized raw input must not reach downstream refinements");
    });
  assert.equal(refined.safeParse(["a", "b"]).success, false);
  assert.equal((await refined.safeParseAsync(["a", "b"])).success, false);

  assert.deepEqual(z.array(element).max(1).parse(["a"]), ["A"]);
  assert.deepEqual(
    [
      ...z
        .set(element)
        .max(1)
        .parse(new Set(["b"])),
    ],
    ["B"],
  );
  assert.equal(z.array(z.string()).max(1).safeParse([1]).success, false);
  assert.equal(z.array(z.string()).min(1).safeParse([]).success, false);
  assert.deepEqual(z.array(element).max(1).catch([]).parse(["a", "b"]), []);
  assert.deepEqual(
    z.union([z.array(z.number()).max(1), z.literal("fallback")]).parse("fallback"),
    "fallback",
  );
  const nested = z.object({ values: z.array(element).max(1, "Too many values") });
  const result = nested.safeParse({ values: ["a", "b"] });
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues[0].path, ["values"]);
  assert.equal(result.error.issues[0].message, "Too many values");
}
