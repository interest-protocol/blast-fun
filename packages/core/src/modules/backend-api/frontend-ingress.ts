import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { canonicalAddress } from "@blast/core/lib/web-security/ingress.ts";
import { isLoopbackHostname } from "@blast/core/lib/loopback.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** Where the frontend's requests arrive: behind Vercel's edge, or a local run that may use loopback fixtures. */
export type FrontendIngress = Readonly<{ vercel: boolean; localRun: boolean }>;

export function frontendIngress(environment: Environment): FrontendIngress {
  return { vercel: environment.VERCEL === "1", localRun: deploymentIdentity(environment).localRun };
}

/** The frontend signs only a platform-overwritten address, or a loopback local fixture. */
export function frontendClientAddress(request: Request, ingress: FrontendIngress): string | null {
  if (ingress.vercel) {
    return canonicalAddress(request.headers.get("x-vercel-forwarded-for") ?? "");
  }
  if (ingress.localRun && isLoopbackHostname(new URL(request.url).hostname)) {
    return "127.0.0.1";
  }
  return null;
}
