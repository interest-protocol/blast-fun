import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";

import { PostHeader } from "./PostHeader";

import type { SocialItemResponse } from "@blast/core/web/contracts/item-routes.ts";

import { PostCard } from "./PostCard";
import styles from "./PostPage.module.css";

/**
 * A post's permalink page: a back bar to Home and "Post", then the one card,
 * live like a card in the feed (rocket, Follow, More). `loaded` is null when
 * the server could not read it: the page says so and offers to try again.
 */
export function PostPage({ loaded, postId }: Readonly<{ postId: string; loaded: Readonly<{ post: SocialItemResponse; nowMs: number }> | null }>) {
  return (
    <div className={styles.page}>
      <PostHeader />
      {loaded ? (
        <PostCard item={loaded.post.item} nowMs={loaded.nowMs} variant="detail" />
      ) : (
        <EmptyState action={<a className="btn btn-line" href={`/p/${postId}`}>Try again</a>} framed role="alert" title="This post couldn’t load">
          Check your connection, then try again.
        </EmptyState>
      )}
    </div>
  );
}
