// Physical fixture only. Never included in the production image or startup path.
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { PartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import { PartnerRecognitionStore } from "@blast/server/modules/partner-api-keys/recognition-store.ts";
import { partnerCapacity } from "@blast/server/modules/partner-api-keys/capacity.ts";
import { configuredRedis } from "@blast/core/lib/redis.ts";
import { DEFAULT_RATE_POLICIES } from "@blast/core/lib/web-security/rate-limits.ts";
import { partnerKeyReader } from "@blast/server/modules/partner-api-keys/repository.ts";
import { createPartnerV1Handlers } from "@blast/server/modules/partner-api/v1/handlers.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import { backendConfig } from "../src/app/api/config.ts";
import { createBackendServer } from "../src/app/server.ts";

const config = backendConfig();
const connection = configuredRedis("quota")!;

const policies = { ...DEFAULT_RATE_POLICIES };
for (const bucket of Object.keys(policies) as (keyof typeof policies)[]) {
  const policy = policies[bucket];
  policies[bucket] = {
    ...policy,
    windows: policy.windows.map((window) => ({ ...window, limit: 100_000 })),
  };
}
let primaryKeyReads = 0;
let redisCommands = 0;
const redis = {
  execute(arguments_: string[]) {
    redisCommands++;
    return connection.execute(arguments_);
  },
  executeAtEpoch(arguments_: string[], epoch: number) {
    redisCommands++;
    return connection.executeAtEpoch(arguments_, epoch);
  },
  connectionEpoch: () => connection.connectionEpoch(),
};
const recognition = new PartnerRecognition(
  primaryPool(),
  new PartnerRecognitionStore(
    redis,
    config.namespace,
    process.env.RATE_LIMIT_SUBJECT_PEPPER!,
    partnerCapacity(process.env.BLAST_PARTNER_CAPACITY_CONFIG),
  ),
);
// Mirrors main.ts: no startup reconcile; readiness comes from recovery and the ready hook.
const stopRecognitionRecovery = recognition.startRecovery();
const handle = createBackendApi({
  keys: {
    async verify(key) {
      primaryKeyReads++;
      return partnerKeyReader.verify(key);
    },
    allowsOrigin: (origin) => partnerKeyReader.allowsOrigin(origin),
  },
  recognition,
  redis,
  namespace: config.namespace,
  subjectPepper: process.env.RATE_LIMIT_SUBJECT_PEPPER!,
  handlers: createPartnerV1Handlers,
  policies,
});
const stats = () => ({
  primaryKeyReads,
  redisCommands,
  peakRssKb: process.resourceUsage().maxRSS,
  rssBytes: process.memoryUsage().rss,
  heapUsedBytes: process.memoryUsage().heapUsed,
});
const runtime = createBackendServer({
  ...config,
  redis,
  preparePartner: handle.preparePartner,
  async handle(...arguments_) {
    return new URL(arguments_[0].url).pathname === "/test/process-stats"
      ? Response.json(stats())
      : handle(...arguments_);
  },
  ready: async () => {
    if (!recognition.ready()) {
      await recognition.reconcile();
    }
    return true;
  },
});
process.send?.("ready");
process.on("message", () => process.send?.(stats()));
process.once(
  "SIGTERM",
  () =>
    void Promise.all([runtime.drain(), stopRecognitionRecovery()]).then(() => {
      connection.close();
      process.exit(0);
    }),
);
