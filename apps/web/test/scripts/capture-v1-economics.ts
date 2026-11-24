// Regenerates packages/core/test/fixtures/modules/launchpad-contract/fixtures/v1-market-economics.json, the cases
// core's sdk-contract.test.ts recomputes through the canonical SDK.
//
//   [BLAST_INFRA_API_KEY=<key>] node --no-warnings --experimental-strip-types test/scripts/capture-v1-economics.ts \
//     --origin http://127.0.0.1:18083 --api-md <blast-infra>/docs/api.md [--revision <blast-infra sha>]
//
// Run blast-infra over its curve checkpoint fixture until /v1/status reports the fixture's last
// checkpoint (124), for example:
//
//   blast-infra --database-url <scratch database> \
//     --local-ingestion-path <blast-infra>/tests/fixtures/curve --listen-address 127.0.0.1:18083 \
//     --launchpad-package-id 0x40781f380cd21fff96a08d0304dbf2b94220f2560df17487d8a541f4a32762ce \
//     --launchpad-original-package-id 0x40781f380cd21fff96a08d0304dbf2b94220f2560df17487d8a541f4a32762ce \
//     --migrators-package-ids 0x2 \
//     --pyth-package-id 0xa70278acefad14997967fd90b24fac9f4fb7b8e186a070e7c0bb8ce476e3b1ca \
//     --quote-table <blast-infra>/deploy/quotes.example.toml --whale-trade-usd 1.5 \
//     --whale-holding-bps 1000 --top-trader-rank-cutoff 1 --network localnet \
//     --deployment-fingerprint 5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c
//
// The cases are every docs/api.md example object with `price` and `inputs`, then GET /v1/pools
// (limit 100) and each pool's /trades (limit 200), each economics shape once.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { blastInfraFetch } from "@blast/core/modules/read-routing/blast-infra.ts";

const { values } = parseArgs({
  options: { origin: { type: "string" }, "api-md": { type: "string" }, revision: { type: "string" } },
});
if (!values.origin || !values["api-md"]) {
  throw new Error("capture-v1-economics needs --origin <blast-infra origin> and --api-md <blast-infra docs/api.md>");
}
const origin = values.origin;
// Carries BLAST_INFRA_API_KEY, when set, as every server read of blast-infra does.
const infraFetch = blastInfraFetch({ origin });
const get = async (path: string) => {
  const response = await infraFetch(new URL(path, origin));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};

type Item = Record<string, unknown>;
const cases: Item[] = [];
const seen = new Set<string>();
function add(source: string, value: Item): void {
  const item: Item = {
    source,
    venue: value.venue ?? String(value.pool_key).split(":")[0],
    price: value.price,
    market_cap: value.market_cap,
    inputs: value.inputs,
    ...("supply" in value ? { supply: value.supply } : {}),
  };
  const key = JSON.stringify({ ...item, source: undefined });
  if (seen.has(key)) return;
  seen.add(key);
  cases.push(item);
}
function walk(value: unknown, path: string, schema: string): void {
  if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`, schema));
  if (typeof value !== "object" || value === null) return;
  const record = value as Item;
  if (typeof record.inputs === "object" && record.inputs !== null && "price" in record) {
    add(`docs/api.md ${schema}${path}`, record);
  }
  for (const [key, child] of Object.entries(record)) walk(child, `${path}.${key}`, schema);
}

const markdown = readFileSync(values["api-md"], "utf8");
for (const [, schema, body] of markdown.matchAll(/<!-- example schema="([^"]+)"[^>]*-->\n```json\n([\s\S]*?)\n```/g)) {
  walk(JSON.parse(body), "", schema);
}
const status = await get("/v1/status");
const pools = await get("/v1/pools?limit=100");
for (const pool of pools.pools as Item[]) add(`engine GET /v1/pools ${pool.pool_key}`, pool);
for (const pool of pools.pools as Item[]) {
  const trades = await get(`/v1/pools/${pool.venue}/${pool.pool_id}/trades?limit=200`);
  for (const trade of trades.trades as Item[]) add(`engine GET /v1/pools/.../trades ${trade.cursor}`, trade);
}

const fixture = new URL("../../../../packages/core/test/fixtures/modules/launchpad-contract/fixtures/v1-market-economics.json", import.meta.url);
writeFileSync(
  fixture,
  `${JSON.stringify(
    {
      description:
        "blast-infra /v1 summaries and trades with the inputs of their derived values. 'docs/api.md' cases are the " +
        "published contract's examples; 'engine' cases are the answers of blast-infra" +
        (values.revision ? ` ${values.revision}` : "") +
        " over its curve checkpoint fixture (tests/fixtures/curve, checkpoints 0-124), captured from GET /v1/pools " +
        "and each pool's /trades by test/scripts/capture-v1-economics.ts. Recomputed through the canonical SDK by " +
        "sdk-contract.test.ts.",
      provenance: status.provenance,
      cases,
    },
    null,
    1,
  )}\n`,
);
console.log(`${cases.length} cases at checkpoint ${status.checkpoint} -> ${fixture.pathname}`);
