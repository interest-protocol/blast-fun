"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRef } from "react";

import { BlastMenu, BlastMenuItem, BlastMenuLinkItem, BlastMenuTrigger } from "#web/components/blast-ui/BlastMenu.tsx";
import { IconButton } from "#web/components/blast-ui/Button.tsx";
import { CloseIcon, CopyIcon } from "#web/components/blast-ui/Icons.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { DotsIcon, ExternalIcon } from "../feed-ui/icons";
import { useSignInGate, useSocialViewer } from "../SignInGate";
import { EXPLORER_NAME } from "./post-format";
import styles from "./PostMenu.module.css";
import { WHY_DELETED_TOAST, WHY_REPORTED_TOAST, deleteWhy, deleteWhyFailureMessage, reportWhy, reportWhyFailureMessage } from "./why-client";
import type { PostMenuItemKind } from "./post-model";
import { POST_MENU_PLACEMENT } from "./post-menu-model";

const signedOut = async () => null;

/**
 * A post's More menu (FEATURE-MAP §3.7) on base-ui's `Menu` (`BlastMenu`,
 * OA-28 M2b): "Copy link to post" (the post's permalink, `/p/<post id>`;
 * toast "Link copied"), "View transaction on Suiscan" (the explorer setting
 * comes later; Suiscan is the default) when the post has a transaction, and
 * the destructive item a post with a why offers — "Report post" on someone
 * else's (`--down`, the close icon, toast "Thanks. The Blast team will
 * review it."), or "Delete this why" on one's own (T-022, an OA-13 addition
 * in the same `.danger` style). Which items appear is `postMenuItems`; a
 * visitor's report goes through the sign-in gate (§0.3).
 *
 * A choice closes it and focus goes back to the dots. It renders into the
 * page's `[data-blast-ui]` root (base-ui's portal): a card's container query
 * would otherwise become the containing block of a fixed menu.
 */
export function PostMenu({ postId, txUrl, items, whyId, onWhyDeleted, profilePath }: Readonly<{
  postId: string;
  profilePath?: string;
  txUrl: string | null;
  /** The items this post offers, in the design's order (`postMenuItems`). */
  items: readonly PostMenuItemKind[];
  /** The why the destructive item acts on; null when the post has none. */
  whyId: string | null;
  /** Called once the author's why is gone, so the card drops it without a reload. */
  onWhyDeleted?: () => void;
}>) {
  const toast = useToast();
  const viewer = useSocialViewer();
  const gate = useSignInGate();
  const busy = useRef(false);

  async function copyLink() {
    const link = `${window.location.origin}/p/${postId}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Link copied");
    } catch {
      toast(link);
    }
  }

  /** The signed-in viewer's call for the destructive item: the menu closes at once, the toast says how it went. */
  async function act(kind: "report-why" | "delete-why") {
    if (!whyId || busy.current) return;
    busy.current = true;
    const options = { getAccessToken: viewer.getAccessToken ?? signedOut };
    const result = await (kind === "report-why" ? reportWhy(options, whyId) : deleteWhy(options, whyId)).catch(() => ({ status: "error" as const })).finally(() => {
      busy.current = false;
    });
    if (result.status !== "ok") {
      toast(kind === "report-why" ? reportWhyFailureMessage(result) : deleteWhyFailureMessage(result));
      return;
    }
    if (kind === "report-why") {
      toast(WHY_REPORTED_TOAST);
      return;
    }
    onWhyDeleted?.();
    toast(WHY_DELETED_TOAST);
  }

  function item(kind: PostMenuItemKind) {
    switch (kind) {
      case "copy-link":
        return (
          <BlastMenuItem nativeButton className={styles.item} key={kind} onClick={() => void copyLink()} render={<button type="button" />}>
            <CopyIcon />
            Copy link to post
          </BlastMenuItem>
        );
      case "transaction":
        return txUrl ? (
          <BlastMenuLinkItem
            className={styles.item}
            closeOnClick
            href={txUrl}
            key={kind}
            rel="noopener noreferrer"
            target="_blank"
          >
            <ExternalIcon />
            View transaction on {EXPLORER_NAME}
          </BlastMenuLinkItem>
        ) : null;
      // A visitor's report opens sign-in instead (§0.3); the link is its fallback.
      case "report-why":
        return gate.signedIn ? (
          <BlastMenuItem nativeButton className={clsx(styles.item, styles.danger)} key={kind} onClick={() => void act(kind)} render={<button type="button" />}>
            <CloseIcon />
            Report post
          </BlastMenuItem>
        ) : (
          <BlastMenuLinkItem
            className={clsx(styles.item, styles.danger)}
            closeOnClick
            key={kind}
            onClick={(event) => gate.openSignIn(event)}
            render={<Link data-gated="sign-in" href={gate.signInHref} prefetch={false} />}
          >
            <CloseIcon />
            Report post
          </BlastMenuLinkItem>
        );
      case "delete-why":
        return (
          <BlastMenuItem nativeButton className={clsx(styles.item, styles.danger)} key={kind} onClick={() => void act(kind)} render={<button type="button" />}>
            <CloseIcon />
            Delete this why
          </BlastMenuItem>
        );
    }
  }

  return (
    <BlastMenu
      className={styles.menu}
      id={`post-menu-${postId}`}
      label="Post"
      placement={() => POST_MENU_PLACEMENT}
      trigger={
        <BlastMenuTrigger aria-label="More" render={<IconButton aria-label="More" size="sm" />} title="More">
          <DotsIcon />
        </BlastMenuTrigger>
      }
    >
      {profilePath ? <BlastMenuLinkItem className={styles.item} closeOnClick render={<Link href={profilePath} />}>View profile</BlastMenuLinkItem> : null}
      {items.map((kind) => item(kind))}
    </BlastMenu>
  );
}
