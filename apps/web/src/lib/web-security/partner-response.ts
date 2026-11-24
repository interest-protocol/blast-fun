import { presaleConnectSources } from "#web/components/presale/config.ts";
import { webConfig } from "../server-config.ts";
import { securityHeaders } from "./browser-policy.ts";


/** The proxy's partner answers carry the full browser security headers, then partner CORS. */
export function applyPartnerBrowserHeaders<T extends Response>(
  response: T,
  accessHeaders: Headers,
  refused: boolean,
): T {
  const browserHeaders = securityHeaders({
    nonce: refused ? crypto.randomUUID().replaceAll("-", "") : null,
    development: webConfig().development,
    presaleConnectSources: presaleConnectSources(webConfig().presale),
  });
  for (const [name, value] of Object.entries(browserHeaders)) response.headers.set(name, value);
  for (const [name, value] of accessHeaders) {
    if (name === "vary") response.headers.append(name, value);
    else response.headers.set(name, value);
  }
  return response;
}
