import { readSocialJson } from "@blast/server/modules/social/route-kit/route.ts";
import { parseFollowingRequest } from "@blast/server/modules/social/home/following.ts";

/** Validate the outer JSON envelope and the selected mode against the same fields. */
export async function readFollowingRequest(request: Request) {
  return parseFollowingRequest(await readSocialJson(request, ["mode", "window"], ["cursor", "limit", "page", "presale_ids", "presale_id"]));
}
