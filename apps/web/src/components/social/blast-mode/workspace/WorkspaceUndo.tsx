"use client";

import { useEffect, useEffectEvent, useRef, useState, type Ref } from "react";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";

/**
 * A temporary recovery action. Hover and keyboard focus (:focus-visible) pause its
 * remaining lifetime; focus a mouse or touch close put on Undo does not, so it still expires.
 * `undoRef` lets a closed layer hand its focus to Undo, in a keyboard's reach;
 * `onClose` then takes focus back when × dismisses the notice.
 */
export function WorkspaceUndo({ label, undo, dismiss, className, undoRef, onClose }: Readonly<{ label: string; undo: () => void; dismiss: () => void; className: string; undoRef?: Ref<HTMLButtonElement>; onClose?: () => void }>) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(6_000);
  const expire = useEffectEvent(dismiss);
  useEffect(() => {
    if (hovered || focused) return;
    const started = Date.now();
    const timeout = setTimeout(() => expire(), remaining.current);
    return () => { clearTimeout(timeout); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [hovered, focused]);
  return <div className={className} role="status" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={event => setFocused(event.target.matches(":focus-visible"))} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <span>{label}</span>
    <Button variant="secondary" size="sm" type="button" ref={undoRef} onClick={undo}>Undo</Button>
    <IconButton variant="ghost" size="sm" type="button" aria-label="Dismiss undo" onClick={() => { dismiss(); onClose?.(); }}>×</IconButton>
  </div>;
}
