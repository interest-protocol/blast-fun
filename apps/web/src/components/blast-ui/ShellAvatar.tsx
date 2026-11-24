"use client";

import clsx from "clsx";
import { useContext } from "react";

import { Avatar } from "./Avatar";

import type { ShellViewer } from "./shell-viewer";
import { ShellAvatarRenderer } from "./shell-avatar-renderer.ts";

/** A round account avatar at one of the design's sizes (`.av`), decorative. */
export function ShellAvatar({ viewer, size }: Readonly<{ viewer: Pick<ShellViewer, "accountId" | "avatarUrl"> & Partial<Pick<ShellViewer, "callsign">>; size: 32 | 34 | 40 }>) {
  const renderAvatar = useContext(ShellAvatarRenderer);
  const avatar = { accountId: viewer.callsign ?? viewer.accountId, avatarUrl: viewer.avatarUrl, size };
  return (
    <span aria-hidden="true" className={clsx("av", `s${size}`)}>
      {/* Seeded by callsign when there is one, as profiles and posts seed it, so a generated avatar matches everywhere. */}
      {renderAvatar ? renderAvatar(avatar) : <Avatar {...avatar} />}
    </span>
  );
}
