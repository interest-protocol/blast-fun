"use client";

import clsx from "clsx";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import shellStyles from "./AppShell.module.css";
import { BlastMenuTrigger, type MenuHandle } from "./BlastMenu";
import { Button } from "./Button";
import { Collapse } from "./Collapse";
import { CREATE_MENU_ID } from "./CreateMenu";
import { ChevronIcon, DotsIcon, PencilIcon, PieIcon, PlusIcon } from "./Icons";
import type { CreateMenuPayload } from "./menu-placement";
import { PrimaryLink } from "./NavigationLink";
import styles from "./MoreNavigation.module.css";

/** Secondary destinations in the phone tab bar. */
export function MoreNavigation({ createMenu, onFeedback }: Readonly<{
  createMenu: MenuHandle<CreateMenuPayload>;
  onFeedback: () => void;
}>) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const pathname = usePathname();
  const portfolioCurrent = pathname === "/portfolio" || pathname?.startsWith("/portfolio/");

  useEffect(() => {
    if (!open) return;
    const breakpoint = window.matchMedia("(max-width: 760px)");
    const closeWhenHidden = () => {
      if (!breakpoint.matches) setOpen(false);
    };
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !insideMore(event.target, container.current)) setOpen(false);
    };
    breakpoint.addEventListener("change", closeWhenHidden);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      breakpoint.removeEventListener("change", closeWhenHidden);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);

  return (
    <div
      className={styles.more}
      ref={container}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node && !insideMore(event.relatedTarget, event.currentTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !open) return;
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <Button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label="More"
        data-current={portfolioCurrent || undefined}
        onClick={() => setOpen(value => !value)}
        ref={trigger}
        className={clsx(shellStyles.navItem, styles.trigger)}
        variant="ghost"
      ><DotsIcon /><span>More</span></Button>
      <Collapse className={styles.panel} focusOnClose={() => trigger.current} id={panelId} open={open}>
        <div className={styles.mobileDestinations}>
          <Button
            aria-haspopup="dialog"
            className={clsx(shellStyles.navItem, styles.destination)}
            onClick={() => {
              trigger.current?.focus();
              setOpen(false);
              onFeedback();
            }}
            variant="nav"
          >
            <PencilIcon />
            <span>Send feedback</span>
          </Button>
          <BlastMenuTrigger
            className={clsx(shellStyles.navItem, styles.destination)}
            handle={createMenu}
            payload="mobile"
          >
            <PlusIcon />
            <span>Create</span>
          </BlastMenuTrigger>
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
