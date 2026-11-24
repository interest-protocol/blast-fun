import clsx from "clsx";

import { SkeletonText as Text } from "#web/components/blast-ui/Skeleton.tsx";
import styles from "#web/components/blast-ui/RouteLoading.module.css";

import feed from "./FeedList.module.css";
import post from "./post/PostCard.module.css";

export function PostSkeleton({ presale = false, named = true }: Readonly<{
  presale?: boolean;
  /** False inside a region that already names the read ("Loading more posts"). */
  named?: boolean;
}>) {
  return (
    <article
      aria-busy={named || undefined}
      aria-hidden={named ? undefined : true}
      aria-label={named ? "Loading post" : undefined}
      className={post.post}
      role={named ? "status" : undefined}
    >
      <span aria-hidden="true" className={clsx(post.lead, presale && post.leadMark, styles.shape)} />
      <div aria-hidden="true" className={post.pbody}>
        <div className={post.prow}>
          <b className={post.name}>
            <Text>Name</Text>
          </b>
          <span className={post.meta}>
            <Text>{presale ? "· time" : "@callsign · time"}</Text>
          </span>
          <span className={post.end}>
            <span />
          </span>
        </div>
        {presale ? <>
          <p className={post.headline}><Text>Presale update</Text></p>
          <p className={post.sub}><Text>The latest from this presale.</Text></p>
        </> : <>
        <div className={post.actLine}>
          <span className={post.act}>
            <svg aria-hidden="true" viewBox="0 0 24 24" />
            <Text>BLAST</Text>
          </span>
          <span className={post.actAmt}>
            <Text>Amount</Text>
          </span>
          <span className={post.tchip}>
            <span className={clsx(post.mk, post.s20, styles.shape)} />
            <Text>Coin</Text>
          </span>
        </div>
        <p className={post.why}>
          <Text>Post content</Text>
        </p>
        </>}
        <div className={post.pfoot}>
          <span className={post.footL}>
            <Text>Reactions</Text>
          </span>
          <span className={styles.shape}>View presale</span>
        </div>
      </div>
    </article>
  );
}

export function FeedSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading posts"
      className={feed.feed}
      role="status"
    >
      {[0, 1, 2].map((key) => (
        <PostSkeleton key={key} presale />
      ))}
    </div>
  );
}
