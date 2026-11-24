import assert from "node:assert/strict";
import test from "node:test";
import { PRESALE_PROOF_PATH } from "@blast/core/modules/backend-api/private/presale-contracts.ts";
import { DAILY_STATS_READ, FIRST_PARTY_WEB_PATHS, firstPartyReadRoute, partnerEndpointBucket, partnerV1Route, PRESALE_PROOF_READ, webPath } from "@blast/server/modules/partner-api/v1/paths.ts";

const PATH = "/api/v1/presales";
const ID = `0x${"a".repeat(64)}`;

test("only audited public reads are allowlisted, including all supported venues", () => {
  const poolVenues = ["cetus", "bluefin", "blast_curve"];
  for (const path of [PATH, `${PATH}/featured`, `${PATH}/${ID}`, `${PATH}/${ID}/proof`, "/api/v1/prices",
    "/api/v1/discovery", "/api/v1/search", "/api/v1/market/status",
    ...["metadata", "metrics", "contracts"].map((operation) => `/api/v1/defillama/${operation}`),
    `/api/v1/market/coins/${ID}%3A%3Acoin%3A%3ACOIN/holders`,
    `/api/v1/market/coins/${ID}%3A%3Acoin%3A%3ACOIN/metadata`,
    `/api/v1/market/launches/${ID}/activity`,
    ...poolVenues.map((venue) => `/api/v1/market/pools/${venue}/${ID}`),
    ...poolVenues.map((venue) => `/api/v1/market/pools/${venue}/${ID}/candles`),
    ...["cetus", "bluefin"].map((venue) => `/api/v1/market/pools/${venue}/${ID}/trades`),
    // LP-14: the launchpad's rewards, wallet, partner and policy reads.
    `/api/v1/market/launches/${ID}/rewards`, `/api/v1/market/launches/${ID}/reward-rounds`,
    ...["launches", "launch-rewards", "launch-holder-rewards"].map((read) => `/api/v1/market/wallets/${ID}/${read}`),
    "/api/v1/market/partners", `/api/v1/market/partners/${ID}`, `/api/v1/market/partners/${ID}/launches`,
    "/api/v1/market/launchpad/policy",
  ]) assert.notEqual(partnerV1Route(path), null, path);
  for (const path of ["/api/social/me", `${PATH}/viewer`, "/api/admin/presales", "/api/gate",
    "/api/social/trades/quote", "/api/presale/allowlists", `${PATH}/unknown`,
    `${PATH}/${ID}/viewer`, `${PATH}/${ID}/proof/extra`, `${PATH}/`, "/api/v1/market/status/extra", "/api/social/%70resales",
    `/api/v1/market/pools/unknown/${ID}`,
    `/api/v1/market/pools/blast_curve/${ID}/trades`, "/api/launchpad/presales", "/api/social/search",
    `/api/v1/market/wallets/${ID}`, `/api/v1/market/wallets/${ID}/trades`, `/api/v1/market/partners/${ID}/earnings`,
    "/api/v1/market/launchpad", `/api/v1/market/launches/${ID}/opening-round/bidders`,
  ]) assert.equal(partnerV1Route(path), null, path);
});

test("the proof read reaches the private gateway's handler path and is partner-only on v1", () => {
  assert.equal(webPath(PRESALE_PROOF_READ), PRESALE_PROOF_PATH);
  assert.equal(FIRST_PARTY_WEB_PATHS.includes(PRESALE_PROOF_PATH), false);
  assert.equal(firstPartyReadRoute(`${PATH}/${ID}/proof`), null);
  assert.notEqual(firstPartyReadRoute(`${PATH}/${ID}`), null);
});

test("daily stats have no first-party route", () => {
  assert.equal(firstPartyReadRoute(DAILY_STATS_READ.path), null);
});

test("coin metadata is partner-only and uses the coin summary quota", () => {
  const path = `/api/v1/market/coins/${ID}%3A%3Acoin%3A%3ACOIN/metadata`;
  assert.deepEqual(partnerV1Route(path), { name: "coin_metadata", sourcePath: path });
  assert.equal(firstPartyReadRoute(path), null);
  assert.equal(partnerEndpointBucket(path), "launchpad_market_coin");
});
