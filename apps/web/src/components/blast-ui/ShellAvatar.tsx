"use client";

import clsx from "clsx";
import { createContext, useContext, type ReactNode } from "react";

import { Avatar, type AvatarProps } from "./Avatar";

import type { ShellViewer } from "./shell-viewer";

export type RenderAvatar = (props: AvatarProps) => ReactNode;
export const ShellAvatarRenderer = createContext<RenderAvatar | undefined>(undefined);

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
