import type { Metadata } from "next";
import type { SocialItemResponse } from "@blast/core/modules/social/contracts/item-routes.ts";

export type PostRead = Readonly<{ status: "ok"; post: SocialItemResponse }> | Readonly<{ status: "not_found" | "error" }>;

/**
 * Search results list a visible post with its own words; an empty or unread post stays out and its links
 * (coins, profiles) are still followed. A missing post gets no tag of its own: not-found adds Next's noindex.
 */
export function postMetadata(postId: string, read: PostRead | null): Metadata {
  if (read === null || read.status === "not_found") return { title: "Nothing here", robots: null };
  const index = read.status === "ok" && Boolean(read.post.item.why?.text.trim());
  return { title: "Post", robots: { index, follow: true }, ...index && { alternates: { canonical: `/p/${postId}` } } };
}
