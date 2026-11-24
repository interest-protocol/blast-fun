import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createDashboardHandler } from "./handler.ts";
import { cookieName, seal } from "./auth.ts";
import { serve, code, hash, envelope } from "../test/fixture.ts";

function rawStatus(origin: string, headers: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(origin, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode!));
    });
    req.on("error", reject);
    req.end();
  });
}

test("one-time login gates private HTML and summary; logout clears the encrypted cookie and reuse fails", async () => {
  let used = false;
  const fixture = await serve((config) =>
    createDashboardHandler(
      config,
      async () => envelope(),
      async (value) => {
        if (value !== code || used) return null;
        used = true;
        return hash;
      },
    ),
  );
  const post = {
    method: "POST",
    headers: {
      Origin: fixture.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `password=${code}`,
    redirect: "manual" as const,
  };
  try {
    const publicPage = await fetch(fixture.origin);
    assert.equal(publicPage.headers.get("referrer-policy"), "same-origin");
    assert.match(await publicPage.text(), /One-time code/);
    assert.equal((await fetch(fixture.origin + "/api/summary")).status, 401);
    assert.equal((await fetch(fixture.origin + "/index.html")).status, 401);
    const login = await fetch(fixture.origin + "/auth/login", post);
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    assert.doesNotMatch(cookie, new RegExp(code + "|" + hash));
    const privatePage = await fetch(fixture.origin, {
      headers: { Cookie: cookie },
    });
    assert.match(await privatePage.text(), /Trading volume/);
    assert.equal(privatePage.headers.get("cache-control"), "no-store");
    assert.match(
      privatePage.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.equal(privatePage.headers.get("x-robots-tag"), "noindex, nofollow");
    const summary = await fetch(fixture.origin + "/api/summary", {
      headers: { Cookie: cookie },
    });
    assert.equal((await summary.json()).accountActivity, null);
    assert.equal(
      (
        await fetch(fixture.origin + "/api/summary", {
          headers: { Cookie: `${cookie}; ${cookie}` },
        })
      ).status,
      401,
    );
    const reuse = await fetch(fixture.origin + "/auth/login", post);
    assert.equal(reuse.headers.get("location"), "/?access=invalid");
    assert.equal(reuse.headers.get("set-cookie"), null);
    const logout = await fetch(fixture.origin + "/auth/logout", {
      method: "POST",
      headers: { Origin: fixture.origin, Cookie: cookie },
      redirect: "manual",
    });
    assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await fetch(fixture.origin + "/api/summary")).status, 401);
  } finally {
    await fixture.close();
  }
});
test("canonical host/origin, exact routes, query, method and bounded forms are enforced before redemption", async () => {
  let redeems = 0;
  const fixture = await serve((config) =>
    createDashboardHandler(
      config,
      async () => {
        throw new Error("secret");
      },
      async () => {
        redeems++;
        return hash;
      },
    ),
  );
  const post = {
    method: "POST",
    headers: {
      Origin: fixture.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `password=${code}`,
    redirect: "manual" as const,
  };
  try {
    assert.equal(
      (
        await fetch(fixture.origin + "/auth/login", {
          ...post,
          headers: { ...post.headers, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(fixture.origin + "/auth/login?", post)).status,
      405,
    );
    assert.equal(
      (await fetch(fixture.origin + "/auth/logout?x=1", post)).status,
      405,
    );
    assert.equal(
      (
        await fetch(fixture.origin + "/auth/login", {
          ...post,
          body: `password=${code}&password=${code}`,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(fixture.origin + "/auth/login", {
          ...post,
          body: "x".repeat(1025),
        })
      ).status,
      400,
    );
    assert.equal(
      await rawStatus(fixture.origin, ["Host", "evil.example"]),
      400,
    );
    assert.equal(
      await rawStatus(fixture.origin, [
        "Host",
        new URL(fixture.origin).host,
        "Host",
        "evil.example",
      ]),
      400,
    );
    assert.equal(
      (await fetch(fixture.origin, { method: "DELETE" })).status,
      405,
    );
    const cookie = `${cookieName(fixture.config)}=${seal(fixture.config, { subject: `code:${hash}`, expires: Date.now() + 100_000 })}`;
    assert.equal(
      (
        await fetch(fixture.origin + "/api/summary?x=1", {
          headers: { Cookie: cookie },
        })
      ).status,
      404,
    );
    const failure = await fetch(fixture.origin + "/api/summary", {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(await failure.json(), { error: "snapshot_unavailable" });
    assert.equal(redeems, 0);
    assert.deepEqual(await (await fetch(fixture.origin + "/live")).json(), {
      status: "live",
    });
  } finally {
    await fixture.close();
  }
});
test("slow and chunked oversized login bodies stop within the handler without consuming a code", async () => {
  let redeems = 0;
  const fixture = await serve((config) =>
    createDashboardHandler(
      config,
      async () => envelope(),
      async () => {
        redeems++;
        return hash;
      },
      { bodyTimeoutMs: 30 },
    ),
  );
  const call = (body: string, complete = false) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        fixture.origin + "/auth/login",
        {
          method: "POST",
          headers: {
            Origin: fixture.origin,
            "Content-Type": "application/x-www-form-urlencoded",
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      if (complete) req.end(body);
      else req.write(body);
    });
  try {
    assert.equal(await call("password="), 413);
    assert.equal(await call("x".repeat(1025), true), 413);
    assert.equal(redeems, 0);
  } finally {
    await fixture.close();
  }
});
test("a third concurrent login is shed while the first two finish with fixed redacted errors", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const fixture = await serve((config) =>
    createDashboardHandler(
      config,
      async () => envelope(),
      async () => {
        entered++;
        await held;
        throw new Error("private-database-password");
      },
    ),
  );
  const post = {
    method: "POST",
    headers: {
      Origin: fixture.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `password=${code}`,
    redirect: "manual" as const,
  };
  const first = fetch(fixture.origin + "/auth/login", post),
    second = fetch(fixture.origin + "/auth/login", post);
  try {
    const deadline = Date.now() + 2000;
    while (entered < 2) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(
      (await fetch(fixture.origin + "/auth/login", post)).status,
      429,
    );
    release();
    assert.equal((await first).status, 503);
    assert.doesNotMatch(
      await (await second).text(),
      /private-database-password/,
    );
  } finally {
    release();
    await fixture.close();
  }
});

test("request admission stops at 32 active reads while DB-free liveness remains available", async () => {
  let entered = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await serve((config) =>
    createDashboardHandler(
      config,
      async () => {
        entered++;
        await held;
        return envelope();
      },
      async () => null,
    ),
  );
  const cookie = `${cookieName(fixture.config)}=${seal(fixture.config, { subject: `code:${hash}`, expires: Date.now() + 100_000 })}`;
  const requests = Array.from({ length: 32 }, () =>
    fetch(fixture.origin + "/api/summary", { headers: { Cookie: cookie } }),
  );
  try {
    const deadline = Date.now() + 2000;
    while (entered < 32) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(
      (
        await fetch(fixture.origin + "/api/summary", {
          headers: { Cookie: cookie },
          signal: AbortSignal.timeout(1000),
        })
      ).status,
      503,
    );
    assert.equal((await fetch(fixture.origin + "/live")).status, 200);
    release();
    assert.equal(
      (await Promise.all(requests)).filter(
        (response) => response.status === 200,
      ).length,
      32,
    );
  } finally {
    release();
    await Promise.allSettled(requests);
    await fixture.close();
  }
});

test("login attempts stop at 30 per minute even when every submitted code is invalid", async () => {
  let redeems = 0;
  const fixture = await serve((config) =>
    createDashboardHandler(
      config,
      async () => envelope(),
      async () => {
        redeems++;
        return null;
      },
    ),
  );
  const post = {
    method: "POST",
    headers: {
      Origin: fixture.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `password=${code}`,
    redirect: "manual" as const,
  };
  try {
    for (let attempt = 0; attempt < 30; attempt++)
      await fetch(fixture.origin + "/auth/login", post);
    assert.equal(
      (await fetch(fixture.origin + "/auth/login", post)).status,
      429,
    );
    assert.equal(redeems, 30);
  } finally {
    await fixture.close();
  }
});
