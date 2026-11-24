import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createSemaphore } from "@blast/server/lib/concurrency.ts";
import {
  createAfterResponseScheduler,
  createRequestWork,
  runWithRequestWork,
  trackRequestWork,
} from "@blast/server/lib/request-work.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

declare global {
  var __blastLogoOwnershipFixture:
    | { decoded: Promise<Buffer>; started(): void }
    | undefined;
}

// These fixtures use Node's scoped module hooks; retain their assertions in the Bun sweep.
if (process.versions.bun) {
  test("Node module-hook fixture", () => {
    execFileSync(
      "node",
      [
        "--no-warnings",
        "--import",
        new URL(
          "../../../../../../scripts/register-runtime-types.mjs",
          import.meta.url,
        ).href,
        "--experimental-strip-types",
        "--test",
        "--test-concurrency=1",
        fileURLToPath(import.meta.url),
      ],
      { stdio: "inherit" },
    );
  });
} else {
  const { registerHooks } = await import("node:module");
  // Replace only this file's dynamic native Sharp boundary; original tests exercise real Sharp.
  registerHooks({
    resolve(specifier, context, next) {
      if (
        specifier === "sharp" &&
        context.parentURL?.endsWith("/presale/receipts/logo.ts")
      ) {
        const source = `export default function sharp() {
        const fixture = globalThis.__blastLogoOwnershipFixture;
        return { async metadata() { return { format: 'png' }; }, resize() { return this; }, png() { return this; },
          toBuffer() { fixture.started(); return fixture.decoded; } };
      }`;
        return {
          url: "data:text/javascript," + encodeURIComponent(source),
          shortCircuit: true,
        };
      }
      return next(specifier, context);
    },
  });
  const { fetchCoinLogo } = await import("./logo.ts");
  const delay = (ms: number) =>
    new Promise<void>((done) => setTimeout(done, ms));

  test("logo DNS timeout keeps the original lookup owned until it actually settles", async () => {
    const lookup = deferred<readonly string[]>();
    const scope = createRequestWork(createAfterResponseScheduler());
    const result = await runWithRequestWork(scope, () =>
      fetchCoinLogo("https://logo.test/image.png", {
        timeoutMs: 25,
        resolve: () => lookup.promise,
        trackWork: trackRequestWork,
      }),
    );
    assert.equal("reason" in result && result.reason, "timeout");
    let complete = false;
    const completion = scope.complete().then(() => {
      complete = true;
    });
    await delay(10);
    assert.equal(complete, false);
    lookup.resolve([]);
    await completion;
    assert.equal(complete, true);
  });

  test("logo timeout keeps native decode ownership and its slot until actual completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "blast-logo-ownership-"));
    const decoded = deferred<Buffer>();
    const started = deferred<void>();
    globalThis.__blastLogoOwnershipFixture = {
      decoded: decoded.promise,
      started: () => started.resolve(),
    };
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=logo.test",
      "-addext",
      "subjectAltName=DNS:logo.test",
    ]);
    const ca = await readFile(cert, "utf8");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const server = createServer(
      { key: await readFile(key), cert: ca },
      (_request, response) => {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(png);
      },
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const slots = createSemaphore(1);
    const scope = createRequestWork(createAfterResponseScheduler());
    try {
      const operation = runWithRequestWork(scope, () =>
        fetchCoinLogo(`https://logo.test:${address.port}/image.png`, {
          ca,
          timeoutMs: 200,
          resolve: async () => ["127.0.0.1"],
          addressAllowed: (value) => value === "127.0.0.1",
          decodeSlots: slots,
          trackWork: trackRequestWork,
        }),
      );
      await started.promise;
      const result = await operation;
      assert.equal("reason" in result && result.reason, "timeout");
      let complete = false;
      const completion = scope.complete().then(() => {
        complete = true;
      });
      await delay(10);
      assert.equal(complete, false);
      await assert.rejects(slots.acquire(10));
      decoded.resolve(png);
      await completion;
      const release = await slots.acquire(10);
      release();
      assert.equal(complete, true);
    } finally {
      decoded.resolve(png);
      await scope.complete();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      globalThis.__blastLogoOwnershipFixture = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
