
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { useId } from "react";

import type { ThesisListPage } from "@blast/core/modules/launchpad-social/list-contract.ts";
import type { PublicPost } from "@blast/core/modules/launchpad-social/post-contract.ts";

import { DataState } from "../primitives/DataState";
import { evidenceLink, KIND_LABELS, postAttribution, postFacts, STANCE_LABELS, type ThesesState } from "./theses-model";
import styles from "./Theses.module.css";

function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/**
 * One post, inert: its text is text (line breaks kept, never markup or
 * links), its evidence is https links only, opened apart from this page,
 * and every label is a checked fact with when it was observed.
 */
function Post({ post, symbol }: Readonly<{ post: PublicPost; symbol: string | null }>) {
  const headingId = useId();
  const facts = postFacts(post, symbol);
  const links = post.evidenceLinks.map(evidenceLink).filter((link) => link !== null);
  return (
    <li>
      <article className={styles.post} aria-labelledby={headingId} data-kind={post.kind} tabIndex={-1}>
        <h3 className={styles.postHeading} id={headingId}>
          <span className={styles.kind}>{KIND_LABELS[post.kind]}</span>
          {post.stance ? <span className={styles.stance} data-stance={post.stance}>{STANCE_LABELS[post.stance]}</span> : null}
          <span className={styles.author}>
            Author <code>{shortId(post.authorIdentityId)}</code>
          </span>
        </h3>
        <p className={styles.body}>{post.body}</p>
        {links.length > 0 ? (
          <div className={styles.evidence}>
            <p className={styles.term}>Evidence</p>
            <ul className={styles.links}>
              {links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} rel="nofollow noopener noreferrer ugc" target="_blank" referrerPolicy="no-referrer">
                    {link.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {facts.length > 0 ? (
          <dl className={styles.facts}>
            {facts.map((fact) => (
              <div key={fact.term} className={styles.fact}>
                <dt className={styles.term}>{fact.term}</dt>
                <dd className={styles.detail}>
                  {fact.full ? <code>{fact.detail}</code> : fact.detail}
                  {fact.checkedAt ? <> <DateStamp at={fact.checkedAt} label="verification time" />.</> : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className={styles.attribution}>{postAttribution(post)}</p>
        <p className={styles.meta}>
          Posted <DateStamp at={post.postedAt} label="post time" />
          {post.createdAt !== post.postedAt ? (
            <>
              {" · "}
              revised <DateStamp at={post.createdAt} label="revision time" />
            </>
          ) : null}
        </p>
      </article>
    </li>
  );
}

/**
 * A launch's public theses, newest first post first, in their honest state.
 * Hidden records never reach this view: the server leaves them out.
 */
export function ThesesView({
  state,
  symbol,
  onMore,
  onRetry,
}: Readonly<{
  state: ThesesState;
  /** The coin's ticker for holding facts; null when unknown. */
  symbol: string | null;
  onMore: () => void;
  onRetry: () => void;
}>) {
  return (
    <div className={styles.theses}>

      <DataState
        state={state.section}
        subject="thesis"
        empty="No thesis on this launch yet. Post the first one below."
        recovery={
          <button className={styles.textButton} type="button" onClick={onRetry}>
            Try again
          </button>
        }
      >
        {(page: ThesisListPage) => (
          <>
            <ol className={styles.list}>
              {page.items.map((post) => <Post key={post.id} post={post} symbol={symbol} />)}
            </ol>
            {state.moreError ? <p className={styles.problem}>{state.moreError}</p> : null}
            {page.nextCursor ? (
              // aria-disabled, not disabled: a focused button that is disabled drops focus to the page.
              <button
                className={styles.button}
                type="button"
                aria-disabled={state.loadingMore || undefined}
                aria-busy={state.loadingMore || undefined}
                onClick={() => {
                  if (!state.loadingMore) onMore();
                }}
              >
                {state.loadingMore ? <LoadingIndicator label="Loading more thesis">Show more thesis</LoadingIndicator> : "Show more thesis"}
              </button>
            ) : null}
          </>
        )}
      </DataState>
    </div>
  );
}
