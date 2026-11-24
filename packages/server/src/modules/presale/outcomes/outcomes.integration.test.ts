import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import {
  createPool,
  migrateDatabase,
} from "@blast/core/modules/database/admin.ts";
import { createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import {
  fixtureChainNode,
  SUI_MAINNET_CHAIN_IDENTIFIER,
  presaleIdentityFixture,
} from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import {
  createPresaleOutcomeFixtureNode,
  PRESALE_OUTCOME_FIXTURE,
} from "../../../../test/fixtures/modules/presale/outcomes/fixtures.ts";
import { createPresaleOutcomeRecorder } from "./recorder.ts";
import { PostgresPresaleOutcomeStore } from "./repository.ts";
import { createPresaleOutcomeRoutes } from "./routes.ts";
import { createPresaleOutcomeVerifier } from "./verifier.ts";
import { createPresaleVisitorRouteHandler } from "./visitor.ts";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";

/**
 * T-017 working path (AC-132, AC-133, AC-135, AC-4) on disposable Postgres:
 * the routes run through the real presale route kit, Postgres rate limits
 * and the web runtime role, against the launchpad's outcome fixture node
 * extended with presale `Committed` transactions. No network.
 */

process.env.MISSION_CONTROL_METRICS = "off";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl
  ? false
  : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const MIGRATIONS = new URL(
  "../../../../../core/src/modules/database/migrations/",
  import.meta.url,
);

const ORIGIN = "https://blast.fun";
const APP_ID = "presale-outcomes-db-app";
const PEPPER = "presale-outcomes-test-pepper-of-32-characters";
const NOW = Math.floor(Date.now() / 1_000);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

const { presaleId, digests, senders, checkpoint, timestampMs } =
  PRESALE_OUTCOME_FIXTURE;
const VISITOR_TWO = "22222222-2222-4222-8222-222222222222";
const VISITOR_THREE = "33333333-3333-4333-8333-333333333333";
const DID_COMMITTER = "did:privy:presale-db-committer";
const DID_EMBEDDED = "did:privy:presale-db-embedded";
const WALLETS: Record<string, string> = {
  [DID_COMMITTER]: senders.committer,
  [DID_EMBEDDED]: senders.embedded,
};

function privyToken(did: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({
    aud: APP_ID,
    exp: NOW + 3_600,
    iat: NOW - 60,
    iss: "privy.io",
    sid: "s-1",
    sub: did,
  });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    dsaEncoding: "ieee-p1363",
    key: keys.privateKey,
  });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

async function clear(admin: Pool): Promise<void> {
  await admin.query("DELETE FROM presale_outcomes");
  await admin.query("DELETE FROM presale_outcome_commitments");
  await admin.query(
    "DELETE FROM mission_control_rate_limit_windows WHERE policy_name IN ('presale_outcome', 'presale_outcome_commit')",
  );
}

async function withDatabase(
  body: (pools: { admin: Pool; web: Pool }) => Promise<void>,
): Promise<void> {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 3 });
  const web = createRuntimePool(
    urlAs(databaseUrl, "blast_web"),
    {
      connectionTimeoutMs: 2_000,
      idleInTransactionMs: 15_000,
      idleTimeoutMs: 1_000,
      lockTimeoutMs: 3_000,
      max: 4,
      statementTimeoutMs: 8_000,
    },
    "presale-outcomes-suite",
  );
  try {
    await migrateDatabase(admin);
    await clear(admin);
    await body({ admin, web });
  } finally {
    await clear(admin).catch(() => undefined);
    await Promise.all([admin.end(), web.end()]);
  }
}

/** The three routes and the recorder over `web`, as the web runtime runs them. */
function presaleOutcomes(web: Pool, clock: () => Date) {
  const node = createPresaleOutcomeFixtureNode();
  // A fixed limiter clock mid-window, so a burst never straddles a window boundary.
  const limiter = new PostgresRateLimitEnforcer({
    pool: web,
    subjectPepper: PEPPER,
    clock: () => new Date("2026-10-02T12:00:20.000Z"),
  });
  const kit = createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({
      appId: APP_ID,
      verificationKey,
    }),
    limiter,
    deployment: createPresaleDeploymentGate({
      environment: {
        PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()),
      },
      node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER),
    }),
  });
  const store = new PostgresPresaleOutcomeStore(web);
  const recorder = createPresaleOutcomeRecorder({
    store,
    verify: createPresaleOutcomeVerifier(async () => node.source),
    embeddedWallet: async (did) => WALLETS[did] ?? null,
    pendingRetryDelaysMs: [],
  });
  return {
    ...createPresaleOutcomeRoutes({
      kit,
      expectedOrigin: ORIGIN,
      store,
      recorder,
      clock,
    }),
    visitor: createPresaleVisitorRouteHandler({
      expectedOrigin: ORIGIN,
      limiter,
    }),
    recorder,
    node,
  };
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "198.51.100.7",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const cookie = (visitor: string) => ({ cookie: `__Host-blast_vid=${visitor}` });
const bearer = (did: string) => ({
  authorization: `Bearer ${privyToken(did)}`,
});

type OutcomeRow = {
  tx_digest: string;
  event_seq: number;
  presale_id: string;
  sender_wallet: string;
  checkpoint: number;
  completed_at: Date;
  visitor_id: string | null;
  visitor_link: string | null;
  privy_did: string | null;
};

async function outcomeRows(admin: Pool): Promise<OutcomeRow[]> {
  const rows = await admin.query<OutcomeRow>(
    `SELECT tx_digest, event_seq, presale_id, sender_wallet, checkpoint::int, completed_at, visitor_id::text, visitor_link, privy_did
     FROM presale_outcomes ORDER BY recorded_at, tx_digest`,
  );
  return rows.rows;
}

test(
  "working path, launchpad off: a new visitor gets a cookie, commits, and its outcome is the sender's with links only where proven",
  { skip },
  async () => {
    const launchpadFlag = process.env.BLAST_LAUNCHPAD_ENABLED;
    const presaleFlag = process.env.BLAST_PRESALE_ENABLED;
    delete process.env.BLAST_LAUNCHPAD_ENABLED;
    process.env.BLAST_PRESALE_ENABLED = "true";
    try {
      await withDatabase(async ({ admin, web }) => {
        // Commitments arrive two seconds before the fixture checkpoint.
        const routes = presaleOutcomes(
          web,
          () => new Date(timestampMs - 2_000),
        );
        const statuses: Array<[string, number, unknown]> = [];
        async function send(label: string, response: Promise<Response>) {
          const answered = await response;
          statuses.push([
            label,
            answered.status,
            answered.status === 204 ? null : await answered.json(),
          ]);
        }

        // A new visitor: the presale page asks for its cookie, then commits before submitting.
        const minted = await routes.visitor(
          post("/api/presale/outcomes/visitor", undefined), testClient("198.51.100.7"),
        );
        assert.equal(minted.status, 204);
        const visitorOne = /^__Host-blast_vid=([0-9a-f-]{36});/.exec(
          minted.headers.get("set-cookie") ?? "",
        )?.[1];
        assert.ok(visitorOne);
        const again = await routes.visitor(
          post("/api/presale/outcomes/visitor", undefined, cookie(visitorOne)), testClient("198.51.100.7"),
        );
        assert.equal(
          again.headers.get("set-cookie"),
          null,
          "an existing cookie is kept",
        );

        const commit = { presale_id: presaleId, tx_digest: digests.commit };
        const second = {
          presale_id: presaleId,
          tx_digest: digests.secondCommit,
        };
        await send(
          "commit",
          routes.commitments(
            post(
              "/api/presale/outcomes/commitments",
              commit,
              cookie(visitorOne),
            ), testClient("198.51.100.7")
          ),
        );
        await send(
          "commit again",
          routes.commitments(
            post(
              "/api/presale/outcomes/commitments",
              commit,
              cookie(visitorOne),
            ), testClient("198.51.100.7")
          ),
        );
        await send(
          "commit, no cookie",
          routes.commitments(post("/api/presale/outcomes/commitments", commit), testClient("198.51.100.7")),
        );
        // Two visitors commit the second digest: contested, so neither is linked by commitment.
        await send(
          "second, visitor two",
          routes.commitments(
            post(
              "/api/presale/outcomes/commitments",
              second,
              cookie(VISITOR_TWO),
            ), testClient("198.51.100.7")
          ),
        );
        await send(
          "second, visitor three",
          routes.commitments(
            post(
              "/api/presale/outcomes/commitments",
              second,
              cookie(VISITOR_THREE),
            ), testClient("198.51.100.7")
          ),
        );

        // Another visitor reports the commit first: still the sender's, linked to the committer.
        await send(
          "outcome by another visitor",
          routes.outcomes(
            post("/api/presale/outcomes", commit, cookie(VISITOR_TWO)), testClient("198.51.100.7")
          ),
        );
        await send(
          "outcome again",
          routes.outcomes(
            post("/api/presale/outcomes", commit, {
              ...cookie(VISITOR_THREE),
              ...bearer(DID_COMMITTER),
            }), testClient("198.51.100.7")
          ),
        );
        // The contested digest: wallet-only, until the sender's own Privy session links its account and visitor.
        await send(
          "second, contested",
          routes.outcomes(
            post("/api/presale/outcomes", second, cookie(VISITOR_TWO)), testClient("198.51.100.7")
          ),
        );
        await send(
          "second, another account",
          routes.outcomes(
            post("/api/presale/outcomes", second, {
              ...cookie(VISITOR_TWO),
              ...bearer(DID_EMBEDDED),
            }), testClient("198.51.100.7")
          ),
        );
        await send(
          "second, sender's session",
          routes.outcomes(
            post("/api/presale/outcomes", second, {
              ...cookie(VISITOR_THREE),
              ...bearer(DID_COMMITTER),
            }), testClient("198.51.100.7")
          ),
        );
        await send(
          "pending",
          routes.outcomes(
            post("/api/presale/outcomes", {
              presale_id: presaleId,
              tx_digest: digests.pending,
            }), testClient("198.51.100.7")
          ),
        );
        await send(
          "other presale",
          routes.outcomes(
            post("/api/presale/outcomes", {
              presale_id: presaleId,
              tx_digest: digests.otherPresale,
            }), testClient("198.51.100.7")
          ),
        );
        assert.deepEqual(statuses, [
          ["commit", 201, { status: "recorded" }],
          ["commit again", 200, { status: "duplicate" }],
          [
            "commit, no cookie",
            422,
            {
              error: {
                code: "no_visitor",
                message: "No visitor session was found.",
              },
            },
          ],
          ["second, visitor two", 201, { status: "recorded" }],
          ["second, visitor three", 201, { status: "recorded" }],
          ["outcome by another visitor", 201, { status: "recorded" }],
          ["outcome again", 200, { status: "duplicate" }],
          ["second, contested", 201, { status: "recorded" }],
          ["second, another account", 200, { status: "duplicate" }],
          ["second, sender's session", 200, { status: "duplicate" }],
          [
            "pending",
            404,
            { error: { code: "not_found", message: "Not found." } },
          ],
          [
            "other presale",
            404,
            { error: { code: "not_found", message: "Not found." } },
          ],
        ]);

        // The sponsored execute route links its reservation's account, with no browser call.
        assert.deepEqual(
          await routes.recorder.recordSponsoredCommit({
            presaleId,
            txDigest: digests.sponsored,
            privyDid: DID_EMBEDDED,
          }),
          { status: "recorded" },
        );

        const chain = {
          presale_id: presaleId,
          checkpoint,
          completed_at: new Date(timestampMs),
        };
        assert.deepEqual(await outcomeRows(admin), [
          // The first report decided the link (the on-time commitment); a later session cannot replace it, but adds its account.
          {
            tx_digest: digests.commit,
            event_seq: 1,
            ...chain,
            sender_wallet: senders.committer,
            visitor_id: visitorOne,
            visitor_link: "signed_commitment",
            privy_did: DID_COMMITTER,
          },
          {
            tx_digest: digests.secondCommit,
            event_seq: 0,
            ...chain,
            sender_wallet: senders.committer,
            visitor_id: VISITOR_THREE,
            visitor_link: "privy_session",
            privy_did: DID_COMMITTER,
          },
          {
            tx_digest: digests.sponsored,
            event_seq: 0,
            ...chain,
            sender_wallet: senders.embedded,
            visitor_id: null,
            visitor_link: null,
            privy_did: DID_EMBEDDED,
          },
        ]);
        const left = await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM presale_outcome_commitments",
        );
        assert.equal(
          left.rows[0]?.n,
          0,
          "every commitment went with its digest's decision",
        );
      });
    } finally {
      if (launchpadFlag === undefined)
        delete process.env.BLAST_LAUNCHPAD_ENABLED;
      else process.env.BLAST_LAUNCHPAD_ENABLED = launchpadFlag;
      if (presaleFlag === undefined) delete process.env.BLAST_PRESALE_ENABLED;
      else process.env.BLAST_PRESALE_ENABLED = presaleFlag;
    }
  },
);

test(
  "a commitment received at or after the checkpoint time links nobody",
  { skip },
  async () => {
    await withDatabase(async ({ admin, web }) => {
      const late = presaleOutcomes(web, () => new Date(timestampMs));
      const commit = { presale_id: presaleId, tx_digest: digests.commit };
      assert.equal(
        (
          await late.commitments(
            post(
              "/api/presale/outcomes/commitments",
              commit,
              cookie(VISITOR_TWO),
            ), testClient("198.51.100.7")
          )
        ).status,
        201,
      );
      assert.equal(
        (await late.outcomes(post("/api/presale/outcomes", commit), testClient("198.51.100.7"))).status,
        201,
      );
      const [row] = await outcomeRows(admin);
      assert.deepEqual(
        [row?.visitor_id, row?.visitor_link, row?.privy_did],
        [null, null, null],
      );
    });
  },
);

test(
  "AC-135: bursts beyond presale_outcome_commit (60/min) and presale_outcome (30/min) per IP are refused, reading no node",
  { skip },
  async () => {
    await withDatabase(async ({ web }) => {
      const routes = presaleOutcomes(web, () => new Date(timestampMs - 2_000));
      const commit = { presale_id: presaleId, tx_digest: digests.pending };
      const commitStatuses: number[] = [];
      for (let index = 0; index < 61; index += 1) {
        const visitor = `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`;
        commitStatuses.push(
          (
            await routes.commitments(
              post(
                "/api/presale/outcomes/commitments",
                commit,
                cookie(visitor),
              ), testClient("198.51.100.7")
            )
          ).status,
        );
      }
      assert.deepEqual(commitStatuses.slice(0, 60), Array(60).fill(201));
      const limited = await routes.commitments(
        post("/api/presale/outcomes/commitments", commit, cookie(VISITOR_TWO)), testClient("198.51.100.7")
      );
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      // The visitor route mints from the same bucket: refused too, without a cookie.
      const visitor = await routes.visitor(
        post("/api/presale/outcomes/visitor", undefined), testClient("198.51.100.7"),
      );
      assert.equal(visitor.status, 429);
      assert.equal(visitor.headers.get("set-cookie"), null);

      const report = { presale_id: presaleId, tx_digest: digests.pending };
      const reportStatuses: number[] = [];
      for (let index = 0; index < 31; index += 1) {
        reportStatuses.push(
          (await routes.outcomes(post("/api/presale/outcomes", report), testClient("198.51.100.7"))).status,
        );
      }
      assert.deepEqual(reportStatuses.slice(0, 30), Array(30).fill(404));
      assert.equal(reportStatuses[30], 429);
      assert.equal(routes.node.reads(), 30, "a refused report reads no node");
    });
  },
);

test(
  "0043 creates the presale outcome tables for the web runtime alone, and rolls back and re-applies",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const admin = createPool(databaseUrl, { max: 2 });
    const name = "0043_presale_outcomes";
    async function tables(): Promise<string[]> {
      const rows = await admin.query<{ name: string }>(
        `SELECT table_name::text AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('presale_outcomes', 'presale_outcome_commitments') ORDER BY 1`,
      );
      return rows.rows.map((row) => row.name);
    }
    try {
      await migrateDatabase(admin);
      assert.deepEqual(await tables(), [
        "presale_outcome_commitments",
        "presale_outcomes",
      ]);
      await admin.query(
        await readFile(new URL(`${name}.down.sql`, MIGRATIONS), "utf8"),
      );
      await admin.query(
        "DELETE FROM mission_control_schema_migrations WHERE name = $1",
        [name],
      );
      assert.deepEqual(await tables(), []);
      assert.deepEqual(await migrateDatabase(admin), [name]);
      assert.deepEqual(await migrateDatabase(admin), [], "re-runnable");

      const outcome = (values: Record<string, unknown>) =>
        admin
          .query(
            `INSERT INTO presale_outcomes (tx_digest, event_seq, presale_id, sender_wallet, checkpoint, completed_at, visitor_id, visitor_link, privy_did)
         VALUES ($1, 0, $2, $3, 1, now(), $4, $5, $6)`,
            [
              values.digest ?? digests.unknown,
              values.presale ?? presaleId,
              values.sender ?? senders.committer,
              values.visitor ?? null,
              values.link ?? null,
              values.did ?? null,
            ],
          )
          .then(
            () => "ok",
            (error: { code?: string }) => error.code,
          );
      assert.equal(
        await outcome({ sender: senders.committer.toUpperCase() }),
        "23514",
        "a canonical sender",
      );
      assert.equal(
        await outcome({ presale: "0x1" }),
        "23514",
        "a canonical presale",
      );
      assert.equal(
        await outcome({ digest: `0x${"ab".repeat(32)}` }),
        "23514",
        "a Base58 digest",
      );
      assert.equal(
        await outcome({ visitor: VISITOR_TWO }),
        "23514",
        "a visitor without a link",
      );
      assert.equal(
        await outcome({ link: "privy_session" }),
        "23514",
        "a link without a visitor",
      );
      assert.equal(
        await outcome({ visitor: VISITOR_TWO, link: "cookie" }),
        "23514",
        "an unknown link",
      );
      assert.equal(
        await outcome({ did: "privy-user" }),
        "23514",
        "a Privy DID",
      );
      assert.equal(
        await outcome({
          visitor: VISITOR_TWO,
          link: "signed_commitment",
          did: DID_COMMITTER,
        }),
        "ok",
      );
      assert.equal(await outcome({}), "23505", "one outcome per event");
      const commitment = (values: unknown[]) =>
        admin
          .query(
            "INSERT INTO presale_outcome_commitments (tx_digest, visitor_id, presale_id, committed_at) VALUES ($1, $2, $3, now())",
            values,
          )
          .then(
            () => "ok",
            (error: { code?: string }) => error.code,
          );
      assert.equal(
        await commitment([digests.unknown, VISITOR_TWO, "0x2"]),
        "23514",
      );
      assert.equal(
        await commitment([digests.unknown, VISITOR_TWO, presaleId]),
        "ok",
      );
      assert.equal(
        await commitment([digests.unknown, VISITOR_TWO, presaleId]),
        "23505",
        "one commitment per digest and visitor",
      );

      const grants = await admin.query<{ grant: string }>(
        `SELECT table_name || ':' || grantee || ':' || string_agg(privilege_type, ',' ORDER BY privilege_type) AS grant
       FROM information_schema.role_table_grants
       WHERE table_name IN ('presale_outcomes', 'presale_outcome_commitments') AND grantee LIKE 'blast\\_%'
       GROUP BY table_name, grantee ORDER BY 1`,
      );
      assert.deepEqual(
        grants.rows.map((row) => row.grant),
        [
          "presale_outcome_commitments:blast_web:DELETE,INSERT,SELECT",
          "presale_outcomes:blast_web:DELETE,INSERT,SELECT",
        ],
      );
      const updatable = await admin.query<{ column: string }>(
        `SELECT column_name::text AS column FROM information_schema.column_privileges
       WHERE table_name = 'presale_outcomes' AND privilege_type = 'UPDATE' AND grantee = 'blast_web' ORDER BY 1`,
      );
      assert.deepEqual(
        updatable.rows.map((row) => row.column),
        ["privy_did", "visitor_id", "visitor_link"],
      );
    } finally {
      await admin
        .query("DELETE FROM presale_outcome_commitments")
        .catch(() => undefined);
      await admin.query("DELETE FROM presale_outcomes").catch(() => undefined);
      await admin.end();
    }
  },
);
