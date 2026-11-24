"use client";

import { StyleInjector } from "@dnd-kit/dom";
import { DragDropProvider as BaseDragDropProvider } from "@dnd-kit/react";
import type { ComponentProps } from "react";

import { useStyleNonce } from "./style-nonce";

type Props = ComponentProps<typeof BaseDragDropProvider>;

/**
 * `@dnd-kit/react`'s provider with the request's CSP nonce (OA-28). While a
 * drag runs, dnd kit's Cursor and Feedback plugins insert a `<style>` into
 * `<head>`; its `StyleInjector` puts `nonce` on it only when configured to,
 * so this adds `StyleInjector.configure({ nonce })` after the default plugins
 * (the registry updates the core injector's options in place). A `plugins`
 * prop still works: an array replaces the defaults, a function receives them.
 */
export function DragDropProvider({ plugins, ...props }: Props) {
  const nonce = useStyleNonce();
  return (
    <BaseDragDropProvider
      {...props}
      plugins={(defaults) => {
        const chosen = typeof plugins === "function" ? plugins(defaults) : (plugins ?? defaults);
        return [...chosen, StyleInjector.configure({ nonce })];
      }}
    />
  );
}
