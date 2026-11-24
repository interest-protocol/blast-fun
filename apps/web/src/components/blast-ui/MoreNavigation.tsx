"use client";

import clsx from "clsx";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import shellStyles from "./AppShell.module.css";
import { BlastMenuTrigger, type MenuHandle } from "./BlastMenu";
import { Button, DisclosureButton } from "./Button";
import { Collapse } from "./Collapse";
import { CREATE_MENU_ID } from "./CreateMenu";
import { ChevronIcon, DotsIcon, PieIcon, PlusIcon, TrophyIcon } from "./Icons";
import type { CreateMenuPayload } from "./menu-placement";
import { PrimaryLink } from "./NavigationLink";
import styles from "./MoreNavigation.module.css";

type MoreNavigationProps =
  | Readonly<{ mobile?: false; createMenu?: never }>
  | Readonly<{ mobile: true; createMenu: MenuHandle<CreateMenuPayload> }>;

/** Secondary destinations stay inside navigation, including on phones. */
export function MoreNavigation({ mobile = false, createMenu }: MoreNavigationProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const pathname = usePathname();
  const current = pathname === "/competitions" || pathname?.startsWith("/competitions/");
  const portfolioCurrent = pathname === "/portfolio" || pathname?.startsWith("/portfolio/");

  useEffect(() => {
    if (!open) return;
    const breakpoint = window.matchMedia("(max-width: 760px)");
    const closeWhenHidden = () => {
      if (breakpoint.matches !== mobile) setOpen(false);
    };
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !insideMore(event.target, container.current)) setOpen(false);
    };
    breakpoint.addEventListener("change", closeWhenHidden);
    if (mobile) document.addEventListener("pointerdown", closeOutside);
    return () => {
      breakpoint.removeEventListener("change", closeWhenHidden);
      if (mobile) document.removeEventListener("pointerdown", closeOutside);
    };
  }, [mobile, open]);

  const triggerProps = {
    "aria-controls": panelId,
    "aria-expanded": open,
    "aria-label": "More",
    // In the rail an open More shows the current destination itself, so only a closed More stands in for it.
    "data-current": (mobile ? current || portfolioCurrent : current && !open) || undefined,
    "data-more-navigation": "",
    onClick: () => setOpen(value => !value),
  };

  return (
    <div
      className={clsx(styles.more, mobile && styles.mobile)}
      ref={container}
      onBlurCapture={(event) => {
        if (mobile && event.relatedTarget instanceof Node && !insideMore(event.relatedTarget, event.currentTarget)) setOpen(false);
        // A breakpoint can hide the focused navigation instance.
        if (trigger.current?.getClientRects().length !== 0) return;
        const visible = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-more-navigation]"))
          .find((button) => button.getClientRects().length > 0);
        if (visible) {
          setOpen(false);
          visible.focus({ preventScroll: true });
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !open) return;
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      {mobile ? <Button
        {...triggerProps}
        ref={trigger}
        className={clsx(shellStyles.navItem, styles.trigger)}
        variant="ghost"
      ><DotsIcon /><span>More</span></Button> : <DisclosureButton
        {...triggerProps}
        ref={trigger}
        className={clsx(shellStyles.navItem, styles.trigger)}
        leadingIcon={<DotsIcon />}
        variant="nav"
      >More</DisclosureButton>}
      <Collapse className={styles.panel} focusOnClose={() => trigger.current} id={panelId} open={open}>
        <div className={mobile ? styles.mobileDestinations : undefined}>
          {createMenu ? (
            <BlastMenuTrigger
              className={clsx(shellStyles.navItem, styles.destination)}
              handle={createMenu}
              payload="mobile"
            >
              <PlusIcon />
              <span>Create</span>
            </BlastMenuTrigger>
          ) : null}
          {mobile ? (
            <PrimaryLink
              aria-current={portfolioCurrent ? "page" : undefined}
              className={clsx(shellStyles.navItem, styles.destination)}
              href="/portfolio"
              onClick={() => setOpen(false)}
            >
              <PieIcon />
              <span>Portfolio</span>
              <ChevronIcon className={styles.destinationChevron} />
            </PrimaryLink>
          ) : null}
          <PrimaryLink
            aria-current={current ? "page" : undefined}
            className={clsx(shellStyles.navItem, styles.destination)}
            href="/competitions"
            onClick={() => { if (mobile) setOpen(false); }}
          >
            <TrophyIcon />
            <span>Competitions</span>
            {mobile ? <ChevronIcon className={styles.destinationChevron} /> : null}
          </PrimaryLink>
        </div>
      </Collapse>
    </div>
  );
}

// The Create menu is portalled outside More.
function insideMore(target: Node, container: HTMLElement | null): boolean {
  return container?.contains(target) === true
    || document.getElementById(CREATE_MENU_ID)?.contains(target) === true;
}
