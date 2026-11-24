import {
  del,
  put,
  type DeleteCommandOptions,
  type PutCommandOptions,
} from "@vercel/blob";

/** Public HTTPS object storage for validated launch images. */
export interface LaunchAssetStore {
  /** Stores `bytes` at exactly `pathname` and returns its public URL. */
  write(
    pathname: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<Readonly<{ url: string }>>;
}

/** Removes a stored object by the URL `write` answered (a replaced sale cover, R3-24). Removing a missing object is not an error. */
export interface LaunchAssetRemover {
  remove(url: string): Promise<void>;
}

export type LaunchAssetDel = (
  urlOrPathname: string,
  options: DeleteCommandOptions,
) => Promise<void>;

export type LaunchAssetPut = (
  pathname: string,
  body: Buffer,
  options: PutCommandOptions,
) => Promise<Readonly<{ url: string }>>;

const ONE_YEAR_SECONDS = 31_536_000;
const WRITE_TIMEOUT_MS = 10_000;

/**
 * A public Vercel Blob store. Pathnames are content addresses, so writing
 * the same image again returns the same stable URL.
 */
export function vercelBlobLaunchAssetStore(
  token: string,
  write: LaunchAssetPut = put,
  remove: LaunchAssetDel = del,
): LaunchAssetStore & LaunchAssetRemover {
  return {
    async remove(url) {
      await remove(url, {
        abortSignal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
        token,
      });
    },
    async write(pathname, bytes, contentType) {
      const result = await write(pathname, bytes, {
        abortSignal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: ONE_YEAR_SECONDS,
        contentType,
        token,
      });
      return { url: result.url };
    },
  };
}

/** The public store for `token` (`LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN`), or null without one. */
export function launchAssetStore(token: string | null): (LaunchAssetStore & LaunchAssetRemover) | null {
  return token ? vercelBlobLaunchAssetStore(token) : null;
}

/** The configured store for processes without the API's runtime config (web scripts). */
export function launchAssetStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): (LaunchAssetStore & LaunchAssetRemover) | null {
  return launchAssetStore(environment.LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN?.trim() || null);
}
