import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import { verifyNativeCards } from "./card-native-checks.ts";
import { cronBackendRelay } from "@blast/server/cron/relay.ts";
import {
  createApprovedXAvatarSnapshot,
  createSeasonZeroCardRecord,
} from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import { freePort, waitForHealth } from "./kit.ts";
import {
  localReplicaUrl,
  RUNTIME_TEST_ENVIRONMENT,
} from "../../../packages/server/test/fixtures/config/runtime-config.ts";

const SITE = "https://frontend.test";
const CSRF = "c".repeat(43);

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await closed;
  clearTimeout(deadline);
}

async function seedOwner(pool: Pool, crew: number) {
  const profileId = randomUUID();
  const walletId = randomUUID();
  const callsign = `retained_owner_${crew}`;
  const address = `0x${String(crew).repeat(64)}`;
  await pool.query(
    `INSERT INTO mission_control_profiles (
      profile_id, privy_did, x_subject, x_handle, sui_address,
      provider_wallet_reference, callsign, disclosure_version, disclosure_accepted_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'v1',now())`,
    [
      profileId,
      `did:privy:${profileId}`,
      `x:${profileId}`,
      callsign,
      address,
      `privy:${profileId}`,
      callsign,
    ],
  );
  await pool.query(
    `INSERT INTO mission_control_account_wallets (
      wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,is_primary,verified_at
    ) VALUES ($1,$2,'embedded',$3,$4,true,now())`,
    [walletId, profileId, address, `privy:${profileId}`],
  );
  await pool.query(
    `INSERT INTO mission_control_season_memberships (
      membership_id,allocation_id,card_id,season_id,profile_id,crew_number,fleet,
      foundry_launch_method,owner_title,zero_fleet,gold,created_at
    ) VALUES ($1,$2,$3,'season-zero',$4,$5,'Recon',NULL,'Zero Fleet Commando',true,true,now())`,
    [randomUUID(), randomUUID(), randomUUID(), profileId, crew],
  );
  return { profileId, walletId, callsign, address };
}

test(
  "native Bun private MissionControl routes serve cards and cleanup, and retired owner routes are gone",
  { timeout: 90_000 },
  async (t) => {
    assert.ok(process.versions.bun, "This physical gate requires native Bun.");
    const database = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
    const redis = process.env.BLAST_TEST_REDIS_URL;
    assert.ok(
      database && redis,
      "Disposable loopback PostgreSQL and Redis are required; never skip.",
    );
    for (const value of [database, redis]) {
      assert.equal(new URL(value).hostname, "127.0.0.1");
    }
    const pool = new Pool({ connectionString: database, max: 2 });
    t.after(() => pool.end());
    await migrateDatabase(pool);
    const owner = await seedOwner(pool, 1);
    const token = "s".repeat(43);
    const cookie = `__Host-blast_session=${token}; __Host-blast_csrf=${CSRF}`;
    const request = (
      path: string,
      method = "GET",
      body?: string,
      headers: Record<string, string> = {},
    ) =>
      new Request(SITE + path, {
        method,
        headers: {
          origin: SITE,
          "sec-fetch-site": "same-origin",
          cookie,
          "x-blast-csrf": CSRF,
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
      });
    const cardMembership = (
      await pool.query(
        "SELECT membership_id,card_id FROM mission_control_season_memberships WHERE profile_id=$1",
        [owner.profileId],
      )
    ).rows[0];
    const cardRecord = createSeasonZeroCardRecord({
      avatar: createApprovedXAvatarSnapshot(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
        "image/png",
      ),
      callsign: owner.callsign,
      cardId: cardMembership.card_id,
      crew: 1,
      title: "CAPCOM",
    });
    await pool.query(
      "INSERT INTO mission_control_cards (card_id,profile_id,membership_id,record_schema,record_version,card_record,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,now())",
      [
        cardMembership.card_id,
        owner.profileId,
        cardMembership.membership_id,
        cardRecord.schema,
        cardRecord.version,
        JSON.stringify(cardRecord),
      ],
    );
    const profilesBefore = (
      await pool.query(
        "SELECT profile_id,privy_did,x_subject,callsign,sui_address,provider_wallet_reference FROM mission_control_profiles ORDER BY profile_id",
      )
    ).rows;
    const walletsBefore = (
      await pool.query(
        "SELECT wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,verified_at FROM mission_control_account_wallets ORDER BY wallet_id",
      )
    ).rows;
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const environment = {
      ...RUNTIME_TEST_ENVIRONMENT,
      PATH: process.env.PATH,
      NODE_ENV: "test",
      CRON_SECRET: "synthetic-cron-secret-local-only-0123456789",
      TZ: "UTC",
      DATABASE_URL: database,
      PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(database, t),
      DATABASE_REPLICA_URL: localReplicaUrl(database),
      BLAST_QUOTA_REDIS_URL: redis,
      BLAST_REDIS_NAMESPACE: `non-social:${randomUUID()}`,
      BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["non-social-fixture"]),
      RATE_LIMIT_SUBJECT_PEPPER: "synthetic-private-subject-pepper-01234567890123456789",
      BLAST_BACKEND_GATEWAY_SECRET: "synthetic-private-gateway-secret-01234567890123456789",
      BLAST_BACKEND_INGRESS_MODE: "direct",
      BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
      NEXT_PUBLIC_SITE_URL: SITE,
      PRIVY_APP_ID: "existing-fixture-app",
      PRIVY_APP_SECRET: "synthetic-local-only-no-provider-call",
      PRIVY_JWT_VERIFICATION_KEY: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      BLAST_DEPLOYMENT_TARGET: "preview",
      BLAST_DEPLOYMENT_BRANCH: "non-social-local-fixture",
    };
    const cwd = await mkdtemp(join(tmpdir(), "blast-non-social-"));
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ["--no-env-file", new URL("../src/main.ts", import.meta.url).pathname],
      {
        cwd,
        env: { ...environment, PORT: String(port), CARD_IMAGE_DIRECTORY: cwd },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const logs: string[] = [];
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.on("data", (data: Buffer) => {
        if (logs.length < 100) {
          logs.push(data.toString());
        }
      });
    }
    t.after(async () => {
      await stop(child);
      await rm(cwd, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${port}`;
    await waitForHealth(child, origin, 40_000);
    const relay = privateBackendRelay(
      parseRelayConfig({ ...environment, BLAST_BACKEND_API_ORIGIN: origin }),
      { clientAddress: () => "192.0.2.1" },
    );
    const send = (path: string, method = "GET", body?: string, headers?: Record<string, string>) =>
      relay(request(path, method, body, headers));
    await verifyNativeCards({
      relay,
      pool,
      key: keys.privateKey,
      profileId: owner.profileId,
      callsign: owner.callsign,
      cardId: cardMembership.card_id,
    });
    const cron = cronBackendRelay(parseRelayConfig({ BLAST_BACKEND_API_ORIGIN: origin }));
    const cronRequest = (action: string, method = "GET", authorized = true) =>
      cron(
        new Request(SITE + `/api/mission-control/maintenance/${action}`, {
          method,
          headers: {
            authorization: authorized ? `Bearer ${environment.CRON_SECRET}` : "",
            cookie,
            "x-blast-partner-key": "no-cron-authority",
          },
        }),
      );
    assert.equal((await cronRequest("cleanup", "GET", false)).status, 401);
    await pool.query(
      `INSERT INTO mission_control_rate_limit_windows (
      policy_name,policy_version,subject_hash,window_seconds,window_started_at,request_count,expires_at
    ) VALUES ('cron-expired-fixture',1,$1,60,now()-interval '3 hours',1,now()-interval '3 hours'+interval '60 seconds')`,
      ["a".repeat(64)],
    );
    const cleanupAnswer = await cronRequest("cleanup");
    assert.equal(cleanupAnswer.status, 200);
    const cleanupReport = (await cleanupAnswer.json()) as {
      ok: boolean;
      tables: Record<string, { deleted: number }>;
    };
    assert.equal(cleanupReport.ok, true);
    assert.equal(cleanupReport.tables.mission_control_rate_limit_windows!.deleted, 1);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM mission_control_rate_limit_windows WHERE policy_name='cron-expired-fixture'",
        )
      ).rows[0].n,
      0,
    );
    const cleanupHead = await cronRequest("cleanup", "HEAD");
    assert.equal(cleanupHead.status, 200);
    assert.equal(await cleanupHead.text(), "");
    for (const action of ["projection", "x-verifications"]) {
      assert.equal((await cronRequest(action)).status, 404);
      assert.equal((await cronRequest(action, "HEAD")).status, 404);
    }

    for (const [path, method] of [
      ["/api/mission-control/admission", "GET"],
      ["/api/mission-control/admission", "POST"],
      ["/api/mission-control/callsign", "POST"],
      ["/api/mission-control/completion", "POST"],
      ["/api/mission-control/completion/wallet-challenge", "POST"],
      ["/api/mission-control/completion/wallet-proof", "POST"],
      ["/api/mission-control/telemetry", "GET"],
      ["/api/mission-control/season-zero", "GET"],
      ["/api/mission-control/owner/codes", "GET"],
      ["/api/mission-control/owner/share", "GET"],
      ["/api/mission-control/owner/share", "POST"],
      ["/api/mission-control/owner", "GET"],
      ["/api/mission-control/owner/card", "GET"],
      ["/api/mission-control/owner/display-name", "PATCH"],
      ["/api/mission-control/owner/wallets", "GET"],
      ["/api/mission-control/owner/wallets/challenge", "POST"],
      ["/api/mission-control/restore", "POST"],
      ["/api/mission-control/slush-wallet-metadata", "GET"],
      ["/api/auth/logout", "POST"],
    ] as const) {
      // No contract means the relay cannot forward the path and private
      // signing refuses it, so no browser or SSR call can reach Bun with it.
      assert.equal(
        privateRoute(method, path, "browser"),
        null,
        `${method} ${path} browser contract`,
      );
      assert.equal(privateRoute(method, path, "ssr-read"), null, `${method} ${path} SSR contract`);
      assert.equal((await send(path, method)).status, 404, `${method} ${path}`);
    }

    const minted = await send("/api/launchpad/csrf", "GET", undefined, {
      cookie: "",
    });
    assert.equal(minted.status, 204);
    assert.equal(minted.headers.get("cache-control"), "no-store");
    assert.equal((await minted.arrayBuffer()).byteLength, 0);
    assert.match(
      minted.headers.getSetCookie()[0]!,
      /^__Host-blast_csrf=[A-Za-z0-9_-]{43}; Path=\/; Secure; SameSite=Strict$/,
    );
    const existingCsrf = await send("/api/launchpad/csrf");
    assert.equal(existingCsrf.status, 204);
    assert.deepEqual(existingCsrf.headers.getSetCookie(), []);
    const headCsrf = await send("/api/launchpad/csrf", "HEAD");
    assert.equal(headCsrf.status, 204);
    assert.equal((await headCsrf.arrayBuffer()).byteLength, 0);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT profile_id,privy_did,x_subject,callsign,sui_address,provider_wallet_reference FROM mission_control_profiles ORDER BY profile_id",
        )
      ).rows,
      profilesBefore,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,verified_at FROM mission_control_account_wallets ORDER BY wallet_id",
        )
      ).rows,
      walletsBefore,
    );
    assert.equal(
      logs.some((line) => line.includes("Unhandled")),
      false,
    );
  },
);
