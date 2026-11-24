import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const { presaleBackendPageReads } = await import("./presales.ts");

test("presale SSR uses exact public paths/queries, backend DTOs and 404-only missing semantics", async () => {
  const seen: Request[] = [];
  let status = 200;
  const reads = presaleBackendPageReads({
    origin: "https://frontend.test",
    headers: async () => new Headers({ "x-vercel-forwarded-for": "192.0.2.1" }),
    relay: async (request) => {
      seen.push(request);
      const path = new URL(request.url).pathname;
      if (status !== 200)
        return Response.json({ error: { code: "unavailable" } }, { status });
      if (path.endsWith("/featured"))
        return Response.json({ presales: [{ presale_id: "synthetic" }] });
      if (path === "/api/social/presales")
        return Response.json({ source: "canonical-backend", presales: [], next_cursor: null });
      return Response.json({ source: "canonical-backend" });
    },
  });
  assert.deepEqual(
    await reads.list({
      status: "live",
      sort: "ending",
      cursor: "a/b+",
      limit: 3,
    }),
    { source: "canonical-backend", presales: [], next_cursor: null },
  );
  assert.equal(
    seen[0]!.url,
    "https://frontend.test/api/social/presales?status=live&sort=ending&cursor=a%2Fb%2B&limit=3",
  );
  assert.equal(seen[0]!.headers.get("x-vercel-forwarded-for"), "192.0.2.1");
  assert.deepEqual(await reads.featured(), [{ presale_id: "synthetic" }]);
  assert.deepEqual(await reads.detail("0x123"), {
    source: "canonical-backend",
  });
  assert.equal(
    seen.at(-1)!.url,
    "https://frontend.test/api/social/presales/0x123",
  );
  status = 404;
  assert.equal(await reads.detail("missing"), null);
  status = 503;
  await assert.rejects(reads.detail("error"));
  await assert.rejects(reads.list({}));
  await assert.rejects(reads.featured());
});
