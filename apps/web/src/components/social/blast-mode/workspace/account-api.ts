import { BLAST_WORKSPACE_PATH } from "@blast/core/web/contracts/blast-workspace.ts";
import { SOCIAL_ME_PATH } from "@blast/core/web/contracts/me.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { socialRequestAuth, type AccessTokenSource } from "../../social-fetch";
import { encodeWorkspaceWriteEnvelope, validateWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { WorkspaceSyncError, type WorkspaceApi } from "./account-sync";

const path = BLAST_WORKSPACE_PATH;
export function createWorkspaceApi(
  input: Readonly<{
    accountId: string;
    getAccessToken?: AccessTokenSource;
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
  }>,
): WorkspaceApi {
  const fetcher = input.fetch ?? gatedFetch;
  // The last Privy token the server answered as this account. A token names
  // one user, so a save sent with it cannot land on another account and needs
  // no `me` read first; a new token (or a wallet cookie) is checked again.
  let verified: string | undefined;
  const bearer = (value: Readonly<{ headers: Readonly<Record<string, string>> }>) => value.headers.authorization;
  async function auth() {
    if (input.signal?.aborted) throw new WorkspaceSyncError("owner_changed");
    const value = await socialRequestAuth(input.getAccessToken);
    if (!value) throw new WorkspaceSyncError("authentication_unavailable");
    return value;
  }
  async function request(url: string, init: RequestInit) {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(10_000);
      response = await fetcher(url, {
        ...init,
        cache: "no-store",
        signal: input.signal
          ? AbortSignal.any([input.signal, timeout])
          : timeout,
      });
    } catch {
      throw new WorkspaceSyncError(
        input.signal?.aborted ? "owner_changed" : "network_unavailable",
        !input.signal?.aborted,
      );
    }
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const retry = response.status === 429 || response.status === 503;
      const header = response.headers.get("retry-after");
      const milliseconds = header
        ? /^\d+(\.\d+)?$/.test(header)
          ? Number(header) * 1000
          : Math.max(0, Date.parse(header) - Date.now())
        : 0;
      throw new WorkspaceSyncError(
        value?.error?.code ?? `http_${response.status}`,
        retry,
        Number.isFinite(milliseconds) ? milliseconds : 0,
      );
    }
    return value;
  }
  function owner(value: { account_id?: unknown } | null) {
    if (value?.account_id !== input.accountId)
      throw new WorkspaceSyncError("owner_changed");
  }
  function revision(value: { revision?: unknown; saved_at_ms?: unknown }) {
    if (
      typeof value.revision !== "string" ||
      !/^(0|[1-9]\d*)$/.test(value.revision) ||
      (value.saved_at_ms !== null &&
        (typeof value.saved_at_ms !== "number" ||
          !Number.isSafeInteger(value.saved_at_ms)))
    )
      throw new WorkspaceSyncError("invalid_response");
  }
  return {
    async read() {
      const authentication = await auth();
      const value = await request(path, authentication);
      owner(value);
      verified = bearer(authentication);
      revision(value);
      if (value.workspace !== null) {
        try {
          value.workspace = validateWorkspace(value.workspace);
        } catch {
          throw new WorkspaceSyncError("workspace_schema_unsupported");
        }
      } else if (value.revision !== "0" || value.saved_at_ms !== null)
        throw new WorkspaceSyncError("invalid_response");
      return value;
    },
    async write(write) {
      const encoded = encodeWorkspaceWriteEnvelope(write);
      if (!encoded.ok) throw new WorkspaceSyncError(encoded.reason);
      const authentication = await auth();
      if (!bearer(authentication) || bearer(authentication) !== verified) {
        const me = await request(SOCIAL_ME_PATH, authentication);
        owner(me?.account);
        verified = bearer(authentication);
      }
      if (input.signal?.aborted) throw new WorkspaceSyncError("owner_changed");
      const value = await request(path, {
        ...authentication,
        method: "PUT",
        headers: {
          ...authentication.headers,
          "content-type": "application/json",
        },
        body: encoded.bytes,
      });
      owner(value);
      revision(value);
      if (value.sequence !== write.sequence || value.saved_at_ms === null)
        throw new WorkspaceSyncError("invalid_acknowledgement");
      return value;
    },
  };
}
