import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { PostPage } from "#web/components/social/post/PostPage.tsx";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { entryIdOfPost, type SocialItemResponse } from "@blast/core/modules/social/contracts/item-routes.ts";
import { readPostFromBackend } from "#web/lib/backend-api/social-reads.ts";

type Params = Promise<{ postId: string }>;

/** One item read per request, shared by the metadata and the page. */
const postOf = cache(readPostFromBackend);

type Loaded = Readonly<{ status: "ok"; post: SocialItemResponse; nowMs: number }> | Readonly<{ status: "not_found" | "error" }>;

async function loadPost(entryId: string): Promise<Loaded> {
  await connection();
  try {
    const post = await postOf(entryId);
    return post ? { status: "ok", post, nowMs: Date.now() } : { status: "not_found" };
  } catch {
    recordMetric("social.post_page", { outcome: "error" });
    return { status: "error" };
  }
}

export async function generateMetadata({ params }: Readonly<{ params: Params }>): Promise<Metadata> {
  const entryId = entryIdOfPost((await params).postId);
  if (!entryId) return { title: "Nothing here" };
  const loaded = await loadPost(entryId);
  if (loaded.status === "not_found") return { title: "Nothing here" };
  return { title: "Post" };
}

/**
 * `/p/<post id>`: one post's permalink (FEATURE-MAP §3.7 "Copy link to
 * post"), the single card in the app's shell, rendered on the server from the
 * replica exactly as `GET /api/social/items/{entry_id}` reads it. The same
 * HTML for every reader. A post that is not visible (or never was) is the
 * not-found view.
 */
export default async function SocialPostPage({ params }: Readonly<{ params: Params }>) {
  const { postId } = await params;
  const entryId = entryIdOfPost(postId);
  if (!entryId) notFound();
  const loaded = await loadPost(entryId);
  if (loaded.status === "not_found") notFound();
  return (
    <PostPage postId={postId} loaded={loaded.status === "ok" ? { post: loaded.post, nowMs: loaded.nowMs } : null} />
  );
}
