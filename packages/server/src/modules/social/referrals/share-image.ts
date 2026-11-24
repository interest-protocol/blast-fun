import { readFile } from "node:fs/promises";
import { cardAssetPath } from "@blast/server/lib/card-assets.ts";
import { renderAsync } from "@resvg/resvg-js";
import { cardEditionForCrew } from "@blast/core/modules/mission-control/card-renderer/editions.ts";
import { brandLockup, CARD_PALETTE as C, STANDARD_CARD as S, svgText } from "@blast/core/modules/mission-control/card-renderer/card-brand.ts";
import type { PresaleReceiptLogo } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import { referralRank, type ReferralInviter } from "@blast/core/modules/social/referrals/share.ts";

/** Reuses each rank’s published background artwork with the inviter’s current profile picture. */
export function referralShareSvg(inviter: ReferralInviter, background?: Buffer, avatar: PresaleReceiptLogo | null = null): string {
  const rank = referralRank(inviter);
  const light = rank !== null && inviter.crew !== null && cardEditionForCrew(inviter.crew) === "pearl";
  const ink = light ? "#2A1A2E" : C.paper;
  const accent = light ? "#B03878" : C.kicker;
  const muted = light ? "#7C6A86" : "#D8D0F0";
  const shade = light ? "#FFFFFF" : "#05030C";
  const defs = `<clipPath id="avatar"><rect x="60" y="185" width="300" height="300" rx="30"/></clipPath><linearGradient id="shade"><stop offset="0" stop-color="${shade}" stop-opacity=".08"/><stop offset=".4" stop-color="${shade}" stop-opacity="${light ? ".18" : ".65"}"/><stop offset="1" stop-color="${shade}" stop-opacity="${light ? ".22" : ".72"}"/></linearGradient>`;
  const handle = `@${inviter.callsign}`;
  let body = (background
    ? `<image href="data:image/png;base64,${background.toString("base64")}" width="1200" height="675" preserveAspectRatio="none"/>`
    : `<rect width="1200" height="675" rx="38" fill="${C.canvas}"/>`) +
    '<rect x="26" y="26" width="1148" height="623" rx="18" fill="url(#shade)"/>' +
    brandLockup(60, 55, 210, C.punch, ink) + svgText(1136, 88, 16, accent, "YOU’RE INVITED", { weight: 800, anchor: "end" }) +
    `<rect x="60" y="185" width="300" height="300" rx="30" fill="${S.screen}"/>` +
    (avatar
      ? `<image href="data:image/png;base64,${avatar.bytes}" x="60" y="185" width="300" height="300" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)"/>`
      : svgText(210, 363, 78, C.kicker, inviter.callsign.slice(0, 2).toUpperCase(), { weight: 800, anchor: "middle" })) +
    `<rect x="60" y="185" width="300" height="300" rx="30" fill="none" stroke="${C.punch}" stroke-width="3"/>` +
    svgText(400, 232, handle.length > 16 ? 42 : 54, accent, handle, { weight: 800 }) +
    svgText(400, 316, 62, ink, "invites you to", { weight: 800 }) +
    svgText(400, 397, 72, ink, "BLAST.FUN", { weight: 900 });
  if (rank) {
    body += svgText(400, 463, 20, accent, `SEASON ZERO · ${rank}`, { weight: 800 }) +
      (inviter.title ? svgText(400, 497, 24, muted, inviter.title, { weight: 700 }) : "");
  }
  body += svgText(60, 603, 20, muted, "blast.fun", { weight: 700 }) +
    svgText(1136, 603, 20, ink, "JOIN THE CREW  →", { weight: 800, anchor: "end" });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><defs>${defs}</defs>${body}</svg>`;
}

export async function renderReferralSharePng(inviter: ReferralInviter, avatar: PresaleReceiptLogo | null = null): Promise<Buffer> {
  const edition = referralRank(inviter) ? cardEditionForCrew(inviter.crew!) : "recruit";
  const background = await readFile(cardAssetPath(`editions/${edition}.png`));
  return (await renderAsync(referralShareSvg(inviter, background, avatar), { font: {
    loadSystemFonts: false, defaultFontFamily: "Inter",
    fontFiles: ["Bold", "ExtraBold", "Black"].map((weight) => cardAssetPath(`fonts/Inter-${weight}.ttf`)),
  } })).asPng();
}
