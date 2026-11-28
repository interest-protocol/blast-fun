"use client";

import { Menu } from "@base-ui/react/menu";
import clsx from "clsx";
import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";

import { usePortalContainer } from "#web/components/ui-libraries/portal.ts";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";

import menuStyles from "./BlastMenu.module.css";
import { ChevronIcon } from "./Icons.tsx";
import type { BlastMenuPlacement } from "./menu-placement.ts";
import { closeMenuMotion, menuMotionMode, openMenuMotion } from "./menu-motion";
import { usePhoneLayout } from "./use-shell-prefs";

export type { BlastMenuPlacement } from "./menu-placement.ts";

/**
 * A menu on base-ui's `Menu` (OA-28 M2b) with the gate's version 5 look and
 * motion: the account menu, the Create menu and a post's More menu.
 *
 * **base-ui owns** the menu's semantics (`role="menu"`/`"menuitem"`, the
 * trigger's `aria-haspopup`/`aria-expanded`/`aria-controls`), the arrow keys
 * (wrapping), Home and End, Escape (focus back to the trigger, with its
 * ring), a press outside, Tab out (to what follows the trigger), an item's
 * press closing the menu, the portal into the Blast UI root, and placement
 * beside the trigger (flip, and 8px inside the viewport).
 *
 * **The gate decides the rest** (`blast-feel-preview-oa36.html`'s
 * `openMenu`/`closeMenu`):
 * - It opens on the **click**, as the gate's `data-act` handler does, not on
 *   the press (base-ui's default for a mouse): the Feel layer reads
 *   `aria-expanded` as the click arrives and glides open or shut by it.
 * - Every opening focuses the first item, so the first ArrowDown moves to the
 *   second; the keyboard's row is the `:focus-visible` one (the gate's
 *   `.mitem:focus-visible`), and the pointer's is CSS `:hover`
 *   (`highlightItemOnHover={false}`: hovering does not move focus).
 * - No typeahead: the gate's menus answer only the arrows and Escape.
 * - It is not modal: the page scrolls and takes presses while it is open, and
 *   a press outside closes it and still lands.
 * - Motion is `menu-motion.ts`: grows from its trigger on desktop and for
 *   anchored menus; sheets rise from the bottom on phones. Reduced motion
 *   fades in place. A menu still
 *   closing is caught when its trigger is pressed again (base-ui keeps the
 *   popup while its exit runs and reopens it; the exit is cancelled).
 *
 * Triggers are `BlastMenuTrigger`s, inside `trigger` or detached with a
 * `handle` (`useMenuHandle`) when they live elsewhere in the shell; a
 * trigger's `payload` picks the placement.
 */

export type MenuHandle<Payload> = Menu.Handle<Payload>;

/** One handle per menu instance, for triggers that live away from the menu (the shell's rail and bars). */
export function useMenuHandle<Payload>(): MenuHandle<Payload> {
  return useState(() => Menu.createHandle<Payload>())[0];
}

type TriggerProps<Payload> = Menu.Trigger.Props<Payload>;

/**
 * A menu's trigger: base-ui's `Menu.Trigger`, opening on the click instead of
 * the press (the gate's timing, and the Feel layer's expand/collapse cue,
 * which reads `aria-expanded` as the click arrives). Pressing it while its
 * menu closes opens it again.
 */
export function BlastMenuTrigger<Payload>({ onMouseDown, onPointerDown, ...props }: TriggerProps<Payload>) {
  // A detached trigger learns its state from the menu once the page is the browser's; the server's HTML still says it is closed.
  const closedOnServer = useHydrated() ? null : { "aria-expanded": false };
  return (
    <Menu.Trigger<Payload>
      {...closedOnServer}
      {...props}
      onMouseDown={(event) => {
        onMouseDown?.(event);
        event.preventBaseUIHandler();
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        event.preventBaseUIHandler();
      }}
    />
  );
}

export const BlastMenuItem = Menu.Item;
export const BlastMenuSeparator = Menu.Separator;
export const BlastMenuLinkItem = Menu.LinkItem;
export const BlastMenuRadioGroup = Menu.RadioGroup;
export const BlastMenuRadioItem = Menu.RadioItem;
export const BlastMenuRadioItemIndicator = Menu.RadioItemIndicator;
export const BlastMenuCheckboxItem = Menu.CheckboxItem;
export const BlastMenuCheckboxItemIndicator = Menu.CheckboxItemIndicator;

/** Keys that would start base-ui's typeahead: one printable character, no modifier (Space still presses the row). */
function typeaheadKey(event: Readonly<{ key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }>): boolean {
  return event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function BlastSubmenu({ label, className, trigger, triggerClassName, children }: Readonly<{
  label: string;
  className: string;
  trigger: ReactNode;
  triggerClassName: string;
  children: ReactNode;
}>) {
  const container = usePortalContainer();
  const phone = usePhoneLayout();

  return (
    <Menu.SubmenuRoot highlightItemOnHover={false}>
      <Menu.SubmenuTrigger className={clsx(triggerClassName, menuStyles.submenuTrigger)} openOnHover={false}>
        {trigger}
        <ChevronIcon />
      </Menu.SubmenuTrigger>
      <Menu.Portal container={container}>
        <Menu.Positioner
          align={phone ? "center" : "start"}
          className={menuStyles.submenuPositioner}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
          collisionPadding={8}
          positionMethod="fixed"
          side={phone ? "top" : "inline-start"}
          sideOffset={phone ? 4 : 16}
        >
          <Menu.Popup
            aria-label={label}
            aria-labelledby={undefined}
            className={clsx(className, menuStyles.popup, menuStyles.submenuPopup)}
          >
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

export function BlastMenu<Payload>({
  handle,
  trigger,
  anchored = false,
  label,
  id,
  className,
  placement,
  finalFocus,
  onOpenChange,
  children,
}: Readonly<{
  /** For detached triggers (`useMenuHandle`). */
  handle?: MenuHandle<Payload>;
  /** An inline trigger (a `BlastMenuTrigger`). */
  trigger?: ReactNode;
  /** Keep the popup beside its trigger on phones instead of docking it as a sheet. */
  anchored?: boolean;
  /** The menu's accessible name (`aria-label`). */
  label: string;
  id?: string;
  /** The menu box's classes. */
  className: string;
  placement: (payload: Payload | undefined) => BlastMenuPlacement;
  finalFocus?: Menu.Popup.Props["finalFocus"];
  onOpenChange?: (open: boolean) => void;
  children: ReactNode | ((payload: Payload | undefined) => ReactNode);
}>) {
  const container = usePortalContainer();
  const [open, setOpen] = useState(false);
  const [triggerId, setTriggerId] = useState<string | null>(null);
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);

  // The gate's openMenu / closeMenu, each time the menu opens or closes (a reopening while it closes included).
  useLayoutEffect(() => {
    if (popup === null) return;
    const mode = menuMotionMode();
    const motion = anchored ? { ...mode, phone: false } : mode;
    if (!open) {
      closeMenuMotion(popup, motion);
      return;
    }
    openMenuMotion(popup, motion);
    popup.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')?.focus({ preventScroll: true });
  }, [anchored, open, popup]);

  return (
    <Menu.Root<Payload>
      handle={handle}
      highlightItemOnHover={false}
      modal={false}
      onOpenChange={(next, details) => {
        setOpen(next);
        if (next) setTriggerId(details.trigger?.id ?? null);
        onOpenChange?.(next);
      }}
      open={open}
      triggerId={triggerId}
    >
      {({ payload }) => {
        const at = placement(payload);
        const offset = at.sideOffset;
        return (
          <>
            {trigger}
            <Menu.Portal container={container}>
              <Menu.Positioner
                align={at.align}
                alignOffset={at.alignOffset ?? 0}
                className={menuStyles.positioner}
                data-anchored={anchored || undefined}
                collisionAvoidance={at.avoid === "flip" ? { side: "flip", align: "shift", fallbackAxisSide: "none" } : { side: "shift", align: "shift", fallbackAxisSide: "none" }}
                collisionPadding={8}
                positionMethod="fixed"
                side={at.side}
                sideOffset={typeof offset === "number" ? offset : (data) => offset(data.side as "top" | "bottom" | "right" | "left")}
              >
                <Menu.Popup
                  aria-label={label}
                  // The menu is named by its label, not by its trigger.
                  aria-labelledby={undefined}
                  className={clsx(className, menuStyles.popup)}
                  id={id}
                  finalFocus={finalFocus}
                  onKeyDown={(event) => {
                    if (typeaheadKey(event)) event.preventBaseUIHandler();
                  }}
                  ref={setPopup}
                  style={{ "--menu-ox": at.originX } as CSSProperties}
                >
                  {typeof children === "function" ? children(payload) : children}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </>
        );
      }}
    </Menu.Root>
  );
}
