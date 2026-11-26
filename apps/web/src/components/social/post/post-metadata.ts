import type { Metadata } from "next";

import type { SocialItemResponse } from "@blast/core/modules/social/contracts/item-routes.ts";

/** What the post read returned: the post, no such visible post, or a failed read. */
export type PostRead = Readonly<{ status: "ok"; post: SocialItemResponse }> | Readonly<{ status: "not_found" | "error" }>;

/**
 * Search results list a visible post with its own words; an empty, missing or
 * unread post stays out. Its links (coins, profiles) are followed either way.
 */
export function postMetadata(postId: string, read: PostRead | null): Metadata {
  const title = read === null || read.status === "not_found" ? "Nothing here" : "Post";
  const index = read?.status === "ok" && Boolean(read.post.item.why?.text.trim());
  return { title, robots: { index, follow: true }, ...index && { alternates: { canonical: `/p/${postId}` } } };
}
