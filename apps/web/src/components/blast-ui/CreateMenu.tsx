"use client";

import clsx from "clsx";
import Link from "next/link";

import styles from "./AppShell.module.css";
import { BlastMenu, type MenuHandle, BlastMenuLinkItem } from "./BlastMenu";
import { createMenuPlacement } from "./create-menu-model.ts";
import menu from "./CreateMenu.module.css";
import { CurveIcon, TicketIcon } from "./Icons";
import type { CreateMenuPayload } from "./menu-placement.ts";
import { CREATE_PATH, LAUNCH_PATH } from "./nav";

export const CREATE_MENU_ID = "blast-create-menu";

/** R3-42: the Create menu's Presale line, the gate's words now that a sale can raise either coin. */
export const CREATE_MENU_PRESALE_LINE = "Raise SUI or USDC at a set price. The pool launches when it fills.";

/** The Create menu's Bonding curve line. */
export const CREATE_MENU_CURVE_LINE = "Trading starts at once, and the price rises with every buy.";

/**
 * The shell opens this menu through detached Create buttons.
 */
export function CreateMenu({ handle }: Readonly<{ handle: MenuHandle<CreateMenuPayload> }>) {
  return (
    <BlastMenu
      className={clsx(styles.menu, menu.menu)}
      handle={handle}
      id={CREATE_MENU_ID}
      label="Actions"
      placement={createMenuPlacement}
    >
      <div className={menu.head}>Create</div>
      <BlastMenuLinkItem className={clsx(styles.mitem, menu.item)} closeOnClick render={<Link href={CREATE_PATH} />}>
        <span className={menu.icon}>
          <TicketIcon />
        </span>
        <span className={clsx(styles.mtext, menu.text)}>
          <b>Presale</b>
          <span>{CREATE_MENU_PRESALE_LINE}</span>
        </span>
      </BlastMenuLinkItem>
      <BlastMenuLinkItem className={clsx(styles.mitem, menu.item)} closeOnClick render={<Link href={LAUNCH_PATH} />}>
        <span className={menu.icon}>
          <CurveIcon />
        </span>
        <span className={clsx(styles.mtext, menu.text)}>
          <b>Bonding curve</b>
          <span>{CREATE_MENU_CURVE_LINE}</span>
        </span>
      </BlastMenuLinkItem>
    </BlastMenu>
  );
}
