import assert from "node:assert/strict";
import type { KeyObject } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import type { Pool } from "pg";
import sharp from "sharp";
import { publicCardImagePath } from "@blast/core/modules/mission-control/card-images/contracts.ts";
import type { privateBackendRelay } from "@blast/server/private/relay.ts";

/** Real production router/kit/SQL/raster/store parity, using synthetic local identities. */
export async function verifyNativeCards(
  input: Readonly<{
    relay: ReturnType<typeof privateBackendRelay>;
    pool: Pool;
    key: KeyObject;
    profileId: string;
    callsign: string;
    cardId: string;
  }>,
) {
  const { relay, pool, profileId, callsign, cardId } = input;
  await pool.query(
    "INSERT INTO mission_control_account_identities(profile_id,provider,provider_subject,verified_at) VALUES($1,'privy',$2,now())",
    [profileId, `did:privy:${profileId}`],
  );
  await pool.query(
    "INSERT INTO social_accounts(account_id,profile_id,onboarded_at) VALUES($1,$1,now())",
    [profileId],
  );
  const accountBefore = (
    await pool.query("SELECT * FROM social_accounts WHERE account_id=$1", [profileId])
  ).rows;
  const token = await new SignJWT({ sid: "native-card-session" })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(`did:privy:${profileId}`)
    .setIssuer("privy.io")
    .setAudience("existing-fixture-app")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(
      await importPKCS8(input.key.export({ type: "pkcs8", format: "pem" }).toString(), "ES256"),
    );
  const call = (
    path: string,
    method = "GET",
    body?: Uint8Array,
    authenticated = true,
    purpose: "browser" | "ssr-read" = "browser",
  ) =>
    relay(
      new Request("https://frontend.test" + path, {
        method,
        headers: {
          origin: "https://frontend.test",
          ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "image/png" } : {}),
        },
        body: body && new Uint8Array(body),
      }),
      purpose,
    );
  const identities = await call(
    `/api/social/card-identities?callsigns=${callsign}`,
    "GET",
    undefined,
    false,
  );
  assert.equal(identities.status, 200);
  const identity = (await identities.json()) as Record<string, { crew: number }>;
  assert.equal(identity[callsign]?.crew, 1);
  assert.doesNotMatch(JSON.stringify(identity), /profile_id|privy|avatar|bytesBase64/);
  const own = "/api/social/me/card";
  assert.equal((await call(own, "GET", undefined, false)).status, 401);
  const ownerImage = await call(own);
  assert.equal(ownerImage.status, 200);
  assert.equal(ownerImage.headers.get("cache-control"), "private, no-store");
  const ownerBytes = Buffer.from(await ownerImage.arrayBuffer());
  assert.deepEqual([...ownerBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const head = await call(own, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const pagePath = `/api/mission-control/card-page/${cardId}`;
  assert.equal(
    (await call(pagePath)).status,
    404,
    "Browser proof cannot use the SSR capability: ssrOnly routes have no browser contract",
  );
  const unpublished = await call(pagePath, "GET", undefined, false, "ssr-read");
  assert.equal(unpublished.status, 200);
  assert.equal(await unpublished.json(), null);
  await pool.query("UPDATE mission_control_cards SET published_at=now() WHERE card_id=$1", [
    cardId,
  ]);
  const published = await call(pagePath, "GET", undefined, false, "ssr-read");
  assert.equal(published.status, 200);
  assert.deepEqual(await published.json(), {
    cardId,
    callsign,
    crew: 1,
    recruitTotal: 0,
  });
  const publicImage = await call(publicCardImagePath(cardId, "card"), "GET", undefined, false);
  assert.equal(publicImage.status, 200);
  assert.equal(publicImage.headers.get("content-type"), "image/png");
  assert.ok((await publicImage.arrayBuffer()).byteLength > 1024);
  const png = await sharp({
    create: { width: 1200, height: 675, channels: 4, background: "#ff4c98" },
  })
    .png()
    .toBuffer();
  const publishPath = "/api/social/me/pnl/card";
  assert.equal((await call(publishPath, "POST", png, false)).status, 401);
  assert.equal((await call(publishPath, "POST", new Uint8Array(4 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await call(publishPath, "POST", new Uint8Array([137, 80, 78, 71]))).status, 400);
  const answer = await call(publishPath, "POST", png);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("cache-control"), "private, no-store");
  const shared = (await answer.json()) as { path: string };
  assert.match(shared.path, new RegExp(`^/card/pnl/[a-f0-9]{64}\\?ref=${callsign}$`));
  const repeat = await call(publishPath, "POST", png);
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), shared);
  const path = shared.path.split("?")[0]!;
  const id = path.split("/").at(-1)!;
  const image = await call(path + "/image", "GET", undefined, false);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const imageHead = await call(path + "/image", "HEAD", undefined, false);
  assert.equal(imageHead.status, 200);
  assert.equal(await imageHead.text(), "");
  const pnlPage = await call(
    `/api/social/pnl-card-page/${id}`,
    "GET",
    undefined,
    false,
    "ssr-read",
  );
  assert.equal(pnlPage.status, 200);
  assert.deepEqual(await pnlPage.json(), { id, exists: true });
  assert.deepEqual(
    (await pool.query("SELECT * FROM social_accounts WHERE account_id=$1", [profileId])).rows,
    accountBefore,
  );
}
