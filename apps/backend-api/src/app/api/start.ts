import { configuredRedis } from "@blast/core/lib/redis.ts";
import {
  endPartnerVerifierPool,
  partnerVerifierPool,
  primaryPool,
} from "@blast/core/modules/database/pool.ts";
import { marketUpstream } from "@blast/server/modules/launchpad-market/shared-runtime.ts";
import { runCleanup } from "@blast/server/modules/mission-control/maintenance/service.ts";
import { configuredPartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import { partnerKeyReader } from "@blast/server/modules/partner-api-keys/repository.ts";
import { createPartnerV1Handlers } from "@blast/server/modules/partner-api/v1/handlers.ts";
import { PRIVATE_HANDLERS } from "@blast/server/private/api.ts";
import { createBackendApi } from "./routing.ts";
import { createEffectHttp } from "./effect-http.ts";
import { createCronHttp } from "./cron-http.ts";
import { backendConfig } from "./config.ts";
import { createBackendOperators } from "./operators.ts";
import { createPrivateHttp } from "./private-http.ts";
import { logBackendListening } from "../logging.ts";
import { createBackendServer } from "../server.ts";

export function startBackend() {
  const config = backendConfig();
  const redis = configuredRedis("quota")!;
  // Replay deadlines may retire this socket without retiring quota/classifier work.
  // Both connections still use the same durable Redis store and hash slot.
  const privateReplayRedis = configuredRedis("private-replay")!;
  const recognition = configuredPartnerRecognition(primaryPool());
  const stopRecognitionRecovery = recognition.startRecovery();
  const effectHttp = createEffectHttp({ upstream: marketUpstream });
  const cronHttp = createCronHttp(() => runCleanup(primaryPool()));
  const privateHttp = createPrivateHttp(PRIVATE_HANDLERS);
  const handle = createBackendApi({
    keys: partnerKeyReader,
    recognition,
    redis,
    namespace: config.namespace,
    subjectPepper: config.runtime.subjectPepper,
    handlers: (limiter) => createPartnerV1Handlers(limiter, effectHttp.handler),
    operators: ({ login }) =>
      createBackendOperators({ ...config.runtime, localRun: config.localRun }, login),
  });

  const runtime = createBackendServer({
    ...config,
    adminToken: config.runtime.adminToken,
    cronSecret: config.runtime.cronSecret,
    redis,
    privateReplayRedis,
    handle,
    preparePartner: handle.preparePartner,
    privateApi: { siteOrigin: config.runtime.siteOrigin, handle: privateHttp.handle },
    cronApi: { handle: cronHttp.handler },
    async ready() {
      await Promise.all([
        redis.execute(["PING"]),
        privateReplayRedis.execute(["PING"]),
        partnerVerifierPool().query("SELECT 1"),
      ]);
      return true;
    },
  });

  logBackendListening("api");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const deadline = setTimeout(() => process.exit(1), runtime.drainTimeoutMs).unref();
      void Promise.all([runtime.drain(), stopRecognitionRecovery()]).then(async () => {
        await Promise.all([
          endPartnerVerifierPool(),
          effectHttp.dispose(),
          cronHttp.dispose(),
          privateHttp.dispose(),
          handle.dispose(),
        ]);
        clearTimeout(deadline);
        redis.close();
        privateReplayRedis.close();
        configuredRedis("cache")?.close();
        process.exit(0);
      });
    });
  }
}
