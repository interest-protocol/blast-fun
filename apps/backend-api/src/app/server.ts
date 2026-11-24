import type { BackendHttpOptions } from "../transport/contracts.ts";
import { createTransportHttp } from "../transport/http.ts";
import { serveBackend, type BackendServerOptions } from "../transport/server.ts";
import { createHealthHttp } from "./health-http.ts";
import { logAfterResponseFailure } from "./logging.ts";

export { type BackendHttpOptions } from "../transport/contracts.ts";

export function createBackendHttp(options: BackendHttpOptions) {
  return createTransportHttp(options, createHealthHttp, logAfterResponseFailure);
}

export function createBackendServer(options: BackendServerOptions) {
  return serveBackend(options, createBackendHttp(options));
}
