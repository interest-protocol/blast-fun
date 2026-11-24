import "server-only";

import { COIN_PAGE_RESOLVE_PRESALE } from "@blast/core/modules/backend-api/private/coin-page-contracts.ts";
import { COIN_WIRE_MAX_BYTES } from "@blast/core/modules/launchpad-coin/wire.ts";
import { parseCoinObjectPageTransfer, parseCoinTypePageTransfer } from "@blast/core/modules/launchpad-coin/transfer.ts";
import {
  boundedPageText,
  readPrivateBackendPage,
  type BackendPageReadDependencies,
} from "./private-page-read.ts";

async function readWire(key: string, dependencies?: BackendPageReadDependencies, query = "") {
  const response = await readPrivateBackendPage(`/api/launchpad/coin-page/${encodeURIComponent(key)}${query}`, dependencies);
  return boundedPageText(response, COIN_WIRE_MAX_BYTES, "Coin read unavailable");
}

export function coinTypeBackendPageRead(dependencies?: BackendPageReadDependencies) {
  return async (coinType: string) => parseCoinTypePageTransfer(await readWire(coinType, dependencies), coinType);
}

export function coinObjectBackendPageRead(dependencies?: BackendPageReadDependencies) {
  return async (objectId: string) =>
    parseCoinObjectPageTransfer(await readWire(objectId, dependencies, `?${COIN_PAGE_RESOLVE_PRESALE}=1`), objectId);
}

export const readCoinObjectPageFromBackend = coinObjectBackendPageRead();
export const readCoinTypePageFromBackend = coinTypeBackendPageRead();
