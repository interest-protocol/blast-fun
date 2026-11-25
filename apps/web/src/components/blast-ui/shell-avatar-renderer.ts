"use client";

import { createContext, type ReactNode } from "react";
import type { AvatarProps } from "./Avatar";

export type RenderAvatar = (props: AvatarProps) => ReactNode;
export const ShellAvatarRenderer = createContext<RenderAvatar | undefined>(undefined);
