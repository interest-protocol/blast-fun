import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { CARD_PAGE_MAX_BYTES } from "@blast/core/modules/mission-control/card-images/page.ts";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const { cardBackendPageRead, pnlBackendPageRead } = await import("./cards.ts");
const id = "11111111-1111-4111-8111-111111111111";
const pnlId = "a".repeat(64);
const card = { cardId: id, callsign: "nova", crew: 1, recruitTotal: 3 };

test("SSR card transport forwards current headers and only validated minimal DTOs", async () => {
  const paths: string[] = [];
  const cookies: (string | null)[] = [];
  let session = "first";
  const cardPath = `/api/mission-control/card-page/${id}`;
  const pnlPath = `/api/social/pnl-card-page/${pnlId}`;
  const dependencies = {
    origin: "https://frontend.test",
    headers: async () => new Headers({ cookie: `synthetic=${session}` }),
    relay: async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      cookies.push(request.headers.get("cookie"));
      assert.equal(request.method, "GET");
      if (path === cardPath) return Response.json(card);
      if (path === pnlPath) return Response.json({ id: pnlId, exists: true });
      throw new Error(`Unexpected SSR request ${path}`);
    },
  };
  const readCard = cardBackendPageRead(dependencies);
  assert.deepEqual(await readCard(id), card);
  session = "second";
  assert.deepEqual(await readCard(id), card);
  assert.deepEqual(await pnlBackendPageRead(dependencies)(pnlId), {
    id: pnlId,
    exists: true,
  });
  assert.deepEqual(paths, [cardPath, cardPath, pnlPath]);
  assert.deepEqual(cookies, ["synthetic=first", "synthetic=second", "synthetic=second"]);
});

test("SSR absence remains distinct from unavailable, wrong identity and private response fields", async () => {
  const run = (body: unknown) => ({
    origin: "https://frontend.test",
    headers: async () => new Headers(),
    relay: async () => Response.json(body),
  });
  assert.equal(await cardBackendPageRead(run(null))(id), null);
  assert.deepEqual(
    await pnlBackendPageRead(run({ id: pnlId, exists: false }))(pnlId),
    { id: pnlId, exists: false },
  );
  await assert.rejects(
    cardBackendPageRead(run({ ...card, avatarUrl: "private" }))(id),
  );
  await assert.rejects(
    cardBackendPageRead(
      run({ ...card, cardId: "22222222-2222-4222-8222-222222222222" }),
    )(id),
  );
  await assert.rejects(
    pnlBackendPageRead(run({ id: pnlId, exists: true, bytes: "private" }))(
      pnlId,
    ),
  );
  await assert.rejects(
    pnlBackendPageRead(run({ id: "b".repeat(64), exists: true }))(pnlId),
  );
});

test("SSR card transport cancels failed and oversized actual streamed responses", async () => {
  for (const [factory, cardId, upstreamError] of [
    [cardBackendPageRead, id, "Card page unavailable"],
    [pnlBackendPageRead, pnlId, "PnL card page unavailable"],
  ] as const) {
    for (const unavailable of [true, false]) {
      let cancelled = false;
      const read = factory({
        origin: "https://frontend.test",
        headers: async () => new Headers(),
        relay: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                if (!unavailable)
                  controller.enqueue(new Uint8Array(CARD_PAGE_MAX_BYTES + 1));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: unavailable ? 503 : 200 },
          ),
      });
      await assert.rejects(read(cardId), {
        message: unavailable ? upstreamError : "Card page unavailable",
      });
      assert.equal(cancelled, true);
    }
  }
});
