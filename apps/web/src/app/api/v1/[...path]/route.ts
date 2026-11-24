import { partnerV1Read } from "#web/modules/partner-api/v1/runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = partnerV1Read;
export const HEAD = partnerV1Read;

export const OPTIONS = partnerV1Read;
