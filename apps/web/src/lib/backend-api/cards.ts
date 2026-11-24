import "server-only";

import {
  CARD_PAGE_MAX_BYTES,
  parseCardPage,
} from "@blast/core/modules/mission-control/card-images/page.ts";
import { parsePnlCardPage } from "@blast/core/modules/social/contracts/pnl-card-sharing.ts";
import {
  boundedPageText,
  readPrivateBackendPage,
  type BackendPageReadDependencies,
} from "./private-page-read.ts";

export function cardBackendPageRead(dependencies?: BackendPageReadDependencies) {
  return async (id: string) => {
    const response = await readPrivateBackendPage(
      `/api/mission-control/card-page/${encodeURIComponent(id)}`,
      dependencies,
    );
    return parseCardPage(
      await boundedPageText(response, CARD_PAGE_MAX_BYTES, "Card page unavailable"),
      id,
    );
  };
}

export const readCardPageFromBackend = cardBackendPageRead();

export function pnlBackendPageRead(dependencies?: BackendPageReadDependencies) {
  return async (id: string) => {
    const response = await readPrivateBackendPage(
      `/api/social/pnl-card-page/${encodeURIComponent(id)}`,
      dependencies,
    );
    return parsePnlCardPage(
      await boundedPageText(response, CARD_PAGE_MAX_BYTES, "PnL card page unavailable", "Card page unavailable"),
      id,
    );
  };
}

export const readPnlPageFromBackend = pnlBackendPageRead();
