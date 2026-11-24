"use client";

import type { ReactNode } from "react";

import { SITE_DOCS_URL, SITE_MAP_URL, SITE_TELEGRAM_URL, SITE_X_URL } from "#web/lib/site.ts";

import styles from "./AppShell.module.css";
import { IconButtonLink } from "./Button";
import { BookIcon, MapIcon, TelegramIcon, XLogo } from "./Icons";
import { Tooltip, TooltipSurface } from "./Tooltip";

const LINKS: readonly Readonly<{ label: string; href: string; icon: ReactNode }>[] = [
  { label: "Follow Blast on X", href: SITE_X_URL, icon: <XLogo /> },
  { label: "Join Blast on Telegram", href: SITE_TELEGRAM_URL, icon: <TelegramIcon /> },
  { label: "How Blast works", href: SITE_MAP_URL, icon: <MapIcon /> },
  { label: "Blast docs", href: SITE_DOCS_URL, icon: <BookIcon /> },
];

/**
 * Blast elsewhere: X, Telegram, the map and the docs, as quiet icon links at the foot of the rail (owner, 2026-11-20).
 * The name shows above the link; the tip never takes the pointer, so in the narrow rail's 2 x 2 grid it can lie over
 * a neighbour without blocking it.
 */
export function RailLinks() {
  return (
    <div aria-label="Blast links" className={styles.railLinks} role="group">
      {LINKS.map(link => (
        <Tooltip.Root disableHoverablePopup key={link.href}>
          <Tooltip.Trigger
            render={(
              <IconButtonLink
                aria-label={`${link.label} (opens in a new tab)`}
                className={styles.railLink}
                href={link.href}
                rel="noopener noreferrer"
                size="touch"
                target="_blank"
                variant="nav"
              >
                {link.icon}
              </IconButtonLink>
            )}
          />
          <TooltipSurface
            popup={{ className: styles.railLinkTip }}
            positioner={{ className: styles.railLinkLayer, collisionPadding: 12, side: "top", sideOffset: 6 }}
          >
            {link.label}
          </TooltipSurface>
        </Tooltip.Root>
      ))}
    </div>
  );
}
