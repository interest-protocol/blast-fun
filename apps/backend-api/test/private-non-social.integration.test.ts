import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import { verifyNativeCards } from "./card-native-checks.ts";
import { cronBackendRelay } from "@blast/server/cron/relay.ts";
import {
  createApprovedXAvatarSnapshot,
  createSeasonZeroCardRecord,
} from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
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
import type { LinkedWalletDto } from "@blast/core/modules/mission-control/account-links/contracts.ts";
import type { OwnerProfileDto } from "@blast/core/modules/mission-control/owner-profile/contracts.ts";
import { MemberSessionService } from "@blast/server/modules/mission-control/member-sessions/service.ts";
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
  "native Bun private MissionControl routes retain sessions and wallet ownership",
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
    const other = await seedOwner(pool, 2);
    const secondary = randomUUID();
    await pool.query(
      `INSERT INTO mission_control_account_wallets (
      wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,is_primary,verified_at
    ) VALUES ($1,$2,'slush',$3,$4,false,now())`,
      [secondary, owner.profileId, `0x${"3".repeat(64)}`, `slush:${secondary}`],
    );
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
    await new MemberSessionService({ pool, tokenFactory: () => token }).issue(
      request("/api/auth/fixture", "POST"),
      SITE,
      { profileId: owner.profileId },
      () => {},
    );
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
    const sessionBefore = (
      await pool.query("SELECT * FROM mission_control_member_sessions WHERE profile_id=$1", [
        owner.profileId,
      ])
    ).rows;
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
    const key = Buffer.alloc(32, 7).toString("base64");
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
      OWNER_CURSOR_KEY: key,
      COMPLETION_SESSION_TOKEN_KEY: key,
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

    const cardPath = "/api/mission-control/owner/card";
    assert.equal((await send(cardPath, "GET", undefined, { cookie: "" })).status, 401);
    const cardResponse = await send(cardPath + "?download=1&format=card");
    assert.equal(cardResponse.status, 200);
    assert.equal(cardResponse.headers.get("content-type"), "image/png");
    assert.equal(cardResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(
      cardResponse.headers.get("content-disposition"),
      `attachment; filename="blast-season-zero-${owner.callsign}.png"`,
    );
    assert.equal(
      cardResponse.headers.get("content-length"),
      null,
      "the shared frontend relay intentionally removes transport length",
    );
    const cardBytes = Buffer.from(await cardResponse.arrayBuffer());
    assert.deepEqual(cardBytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.ok(cardBytes.byteLength > 1024);

    const cardHead = await send(cardPath, "HEAD");
    assert.equal(cardHead.status, 200);
    assert.equal(cardHead.headers.get("content-type"), "image/png");
    assert.equal((await cardHead.arrayBuffer()).byteLength, 0);
    const shareCard = await send(cardPath + "?format=share");
    assert.equal(shareCard.status, 200);
    const shareBytes = Buffer.from(await shareCard.arrayBuffer());
    assert.deepEqual(shareBytes.subarray(0, 8), cardBytes.subarray(0, 8));
    assert.notEqual(
      shareBytes.readUInt32BE(16),
      cardBytes.readUInt32BE(16),
      "format query selects real share dimensions",
    );
    assert.equal((await send(cardPath, "POST")).status, 404);
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
    ] as const) {
      assert.equal((await send(path, method)).status, 404, path);
    }

    const ownerResponse = await send("/api/mission-control/owner");
    assert.equal(ownerResponse.status, 200);
    const retained = (await ownerResponse.json()) as { owner: OwnerProfileDto };
    assert.equal(retained.owner.profile.callsign, owner.callsign);
    assert.equal(retained.owner.wallet.address, owner.address);
    assert.deepEqual(
      retained.owner.wallets.map((wallet) => wallet.id).sort(),
      [owner.walletId, secondary].sort(),
    );
    assert.equal(ownerResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(ownerResponse.headers.getSetCookie(), []);
    const anonymous = await send("/api/mission-control/owner", "GET", undefined, { cookie: "" });
    assert.equal(anonymous.status, 401);
    for (const path of [
      "/api/mission-control/owner",
      "/api/mission-control/owner/recruits",
      "/api/mission-control/owner/wallets",
    ]) {
      const response = await send(path);
      assert.equal(response.status, 200, path);
      await response.arrayBuffer();
      const head = await send(path, "HEAD");
      assert.equal(head.status, 200, path);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
    const wallets = async () => {
      const response = await send("/api/mission-control/owner/wallets");
      assert.equal(response.status, 200);
      return ((await response.json()) as { wallets: LinkedWalletDto[] }).wallets;
    };
    const jsonHeaders = { "content-type": "application/json" };
    const primaryPath = "/api/mission-control/owner/wallets/primary";
    const beforeDenied = await wallets();
    const missingCsrf = await send(primaryPath, "PATCH", JSON.stringify({ walletId: secondary }), {
      ...jsonHeaders,
      "x-blast-csrf": "",
    });
    assert.equal(missingCsrf.status, 403);
    const foreign = await send(
      primaryPath,
      "PATCH",
      JSON.stringify({ walletId: other.walletId }),
      jsonHeaders,
    );
    assert.equal(foreign.status, 404);
    assert.equal(
      ((await foreign.json()) as { error: { code: string } }).error.code,
      "WALLET_NOT_FOUND",
    );
    assert.deepEqual(await wallets(), beforeDenied);
    for (let repeat = 0; repeat < 2; repeat++) {
      const changed = await send(
        primaryPath,
        "PATCH",
        JSON.stringify({ walletId: secondary }),
        jsonHeaders,
      );
      assert.equal(changed.status, 200);
      const result = (await changed.json()) as { wallets: LinkedWalletDto[] };
      assert.deepEqual(
        result.wallets.filter((wallet) => wallet.primary).map((wallet) => wallet.id),
        [secondary],
      );
    }
    const renamed = await send(
      "/api/mission-control/owner/display-name",
      "PATCH",
      JSON.stringify({ displayName: "Retained Pilot" }),
      jsonHeaders,
    );
    assert.equal(renamed.status, 200);
    assert.equal(
      ((await renamed.json()) as { profile: { displayName: string } }).profile.displayName,
      "Retained Pilot",
    );
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
        await pool.query("SELECT * FROM mission_control_member_sessions WHERE profile_id=$1", [
          owner.profileId,
        ])
      ).rows,
      sessionBefore,
    );
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
    // Actual SDK signing verifies offline; no RPC or on-chain transaction is submitted.
    const otherToken = "t".repeat(43);
    const otherCookie = `__Host-blast_session=${otherToken}; __Host-blast_csrf=${CSRF}`;
    await new MemberSessionService({
      pool,
      tokenFactory: () => otherToken,
    }).issue(request("/fixture", "POST"), SITE, { profileId: other.profileId }, () => {});
    assert.equal(
      (
        await send(
          cardPath + `?profileId=${owner.profileId}&cardId=${cardMembership.card_id}`,
          "GET",
          undefined,
          { cookie: otherCookie },
        )
      ).status,
      404,
      "another member cannot select the retained owner's card through query input",
    );
    const signer = Ed25519Keypair.generate();
    const linkedAddress = signer.toSuiAddress();
    const walletBody = JSON.stringify({
      address: linkedAddress,
      kind: "slush",
    });
    const badCsrfChallenge = await send(
      "/api/mission-control/owner/wallets/challenge",
      "POST",
      walletBody,
      { "content-type": "application/json", "x-blast-csrf": "" },
    );
    assert.equal(badCsrfChallenge.status, 403);
    const anonymousChallenge = await send(
      "/api/mission-control/owner/wallets/challenge",
      "POST",
      walletBody,
      {
        "content-type": "application/json",
        cookie: `__Host-blast_csrf=${CSRF}`,
      },
    );
    assert.equal(anonymousChallenge.status, 401);
    const issued = await send("/api/mission-control/owner/wallets/challenge", "POST", walletBody, {
      "content-type": "application/json",
      cookie: otherCookie,
    });
    assert.equal(issued.status, 201);
    const challenge = (
      (await issued.json()) as {
        challenge: { challengeId: string; message: string };
      }
    ).challenge;
    const signed = await signer.signPersonalMessage(new TextEncoder().encode(challenge.message));
    const linkBody = JSON.stringify({
      address: linkedAddress,
      kind: "slush",
      challengeId: challenge.challengeId,
      message: challenge.message,
      signature: signed.signature,
    });
    const linked = await send("/api/mission-control/owner/wallets", "POST", linkBody, {
      "content-type": "application/json",
      cookie: otherCookie,
    });
    assert.equal(linked.status, 201);
    const linkedRows = (
      await pool.query("SELECT * FROM mission_control_account_wallets WHERE sui_address=$1", [
        linkedAddress,
      ])
    ).rows;
    assert.equal(linkedRows.length, 1);
    assert.equal(linkedRows[0].profile_id, other.profileId);
    assert.equal(linkedRows[0].wallet_kind, "slush");
    assert.equal(
      (
        await send("/api/mission-control/owner/wallets", "POST", linkBody, {
          "content-type": "application/json",
          cookie: otherCookie,
        })
      ).status,
      400,
      "a consumed proof cannot attach twice",
    );
    // Recovery proves ownership of an already completed legacy crew profile.
    const membership = (
      await pool.query("SELECT * FROM mission_control_season_memberships WHERE profile_id=$1", [
        other.profileId,
      ])
    ).rows[0];
    await pool.query(
      "INSERT INTO mission_control_invitation_allocations (allocation_id,profile_id,membership_id,policy_version,code_count,created_at) VALUES ($1,$2,$3,'season-zero-v3',0,now())",
      [membership.allocation_id, other.profileId, membership.membership_id],
    );
    await pool.query(
      "INSERT INTO mission_control_cards (card_id,profile_id,membership_id,record_schema,record_version,card_record,render_status,created_at) VALUES ($1,$2,$3,'blast.season-zero-card',3,'{}','pending',now())",
      [membership.card_id, other.profileId, membership.membership_id],
    );
    const restoreRequest = {
      address: linkedAddress,
      recoveryId: "retained-crew-recovery",
      walletKind: "slush",
    };
    const restoredChallengeResponse = await send(
      "/api/mission-control/restore",
      "PUT",
      JSON.stringify(restoreRequest),
      {
        "content-type": "application/json; charset=utf-8",
        cookie: `__Host-blast_csrf=${CSRF}`,
      },
    );
    assert.equal(restoredChallengeResponse.status, 201);
    const recovery = (
      (await restoredChallengeResponse.json()) as {
        challenge: { challengeId: string; message: string };
      }
    ).challenge;
    const recoverySignature = await signer.signPersonalMessage(
      new TextEncoder().encode(recovery.message),
    );
    const restored = await send(
      "/api/mission-control/restore",
      "POST",
      JSON.stringify({
        ...restoreRequest,
        challengeId: recovery.challengeId,
        message: recovery.message,
        signature: recoverySignature.signature,
      }),
      {
        "content-type": "application/json",
        cookie: `__Host-blast_csrf=${CSRF}`,
      },
    );
    assert.equal(restored.status, 201);
    assert.equal(((await restored.json()) as { restored: boolean }).restored, true);
    const restoredCookie = restored.headers.getSetCookie()[0];
    assert.ok(restoredCookie?.startsWith("__Host-blast_session="));
    const resolved = await new MemberSessionService({ pool }).authorize(
      new Request(SITE + "/fixture", {
        headers: { cookie: restoredCookie.split(";", 1)[0]! },
      }),
    );
    assert.equal(resolved.profileId, other.profileId, "recovery returns the original account");
    assert.equal(
      (await pool.query("SELECT count(*)::integer AS n FROM mission_control_profiles")).rows[0].n,
      2,
      "recovery creates no profile",
    );
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
        await pool.query("SELECT * FROM mission_control_member_sessions WHERE session_id=$1", [
          sessionBefore[0].session_id,
        ])
      ).rows,
      sessionBefore,
      "original live session remains unchanged after recovery",
    );
    const absentSigner = Ed25519Keypair.generate();
    const absentRestore = {
      address: absentSigner.toSuiAddress(),
      recoveryId: "no-existing-profile",
      walletKind: "slush",
    };
    const absentIssue = await send(
      "/api/mission-control/restore",
      "PUT",
      JSON.stringify(absentRestore),
      {
        "content-type": "application/json",
        cookie: `__Host-blast_csrf=${CSRF}`,
      },
    );
    assert.equal(absentIssue.status, 201);
    const absentChallenge = (
      (await absentIssue.json()) as {
        challenge: { challengeId: string; message: string };
      }
    ).challenge;
    const absentSignature = await absentSigner.signPersonalMessage(
      new TextEncoder().encode(absentChallenge.message),
    );
    const absent = await send(
      "/api/mission-control/restore",
      "POST",
      JSON.stringify({
        ...absentRestore,
        challengeId: absentChallenge.challengeId,
        message: absentChallenge.message,
        signature: absentSignature.signature,
      }),
      {
        "content-type": "application/json",
        cookie: `__Host-blast_csrf=${CSRF}`,
      },
    );
    assert.equal(absent.status, 401);
    assert.deepEqual(absent.headers.getSetCookie(), []);
    assert.equal(
      (await pool.query("SELECT count(*)::integer AS n FROM mission_control_profiles")).rows[0].n,
      2,
      "valid proof for an absent owner cannot create an account",
    );
    const refusedLogout = await send("/api/auth/logout", "POST", "{}", {
      "x-blast-csrf": "",
    });
    assert.equal(refusedLogout.status, 403);
    const loggedOut = await send("/api/auth/logout", "POST", "ignored payload");
    assert.equal(loggedOut.status, 204);
    assert.equal(
      loggedOut.headers.getSetCookie()[0],
      "__Host-blast_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
    const sessionAfter = (
      await pool.query("SELECT * FROM mission_control_member_sessions WHERE session_id=$1", [
        sessionBefore[0].session_id,
      ])
    ).rows[0];
    assert.equal(sessionAfter.session_id, sessionBefore[0].session_id);
    assert.equal(sessionAfter.token_hash, sessionBefore[0].token_hash);
    assert.equal(sessionAfter.profile_id, owner.profileId);
    assert.ok(sessionAfter.revoked_at);
    assert.equal((await send("/api/mission-control/owner")).status, 401);
    assert.equal(
      logs.some((line) => line.includes("Unhandled")),
      false,
    );
  },
);
