import { cardAssetPath } from "@blast/server/lib/card-assets.ts";
import { renderAsync, Resvg } from "@resvg/resvg-js";

import { fundingAmount, saleMoney } from "@blast/core/modules/presale/presentation.ts";
import { bloomGradient, brandLockup, CARD_PALETTE as C, linearGradient, STANDARD_CARD as S, svgText } from "@blast/core/modules/mission-control/card-renderer/card-brand.ts";
import type { PresaleReceiptLogo } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import type { SocialPresaleSummary } from "@blast/core/modules/social/contracts/presales.ts";

export type PresaleShareArtwork = Readonly<{ logo: PresaleReceiptLogo | null; cover: PresaleReceiptLogo | null }>;

const font = {
  loadSystemFonts: false,
  defaultFontFamily: "Inter",
  fontFiles: ["Bold", "ExtraBold", "Black"].map((weight) => cardAssetPath(`fonts/Inter-${weight}.ttf`)),
};

function displayText(value: string, max: number): string {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()].slice(0, max).join("");
}

function fittedText(x: number, y: number, size: number, value: string, width: number, fill: string = C.paper): string {
  const text = svgText(x, y, size, fill, value, { weight: 800 });
  const bounds = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675">${text}</svg>`, { font }).getBBox();
  return svgText(x, y, size, fill, value, {
    weight: 800,
    length: bounds && bounds.x + bounds.width > x + width ? width : undefined,
  });
}

/** The existing Blast card's frame, grid, glow and logo monitor, for a sale rather than a wallet receipt. */
export function presaleShareSvg(sale: SocialPresaleSummary, artwork: PresaleShareArtwork): string {
  const name = displayText(sale.name, 80);
  const symbol = displayText(sale.symbol.replace(/^\$+/, ""), 24);
  const tagline = displayText(sale.metadata?.tagline ?? "", 80);
  const funding = fundingAmount(sale.raised_atoms, sale.target_atoms);
  const raised = saleMoney(sale, sale.raised_usd, sale.raised_atoms);
  const target = saleMoney(sale, sale.target_usd, sale.target_atoms);
  const defs = linearGradient("frame", S.frame, 0, 0, 1, 1) +
    linearGradient("bg", S.bg, 0, 0, 1, 0.5) +
    bloomGradient("glow", 1000, 80, 1100, C.punch, 0.3) +
    '<pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#1E1E23"/></pattern>' +
    '<clipPath id="body"><rect x="14" y="14" width="1172" height="647" rx="26"/></clipPath>' +
    '<clipPath id="screen"><rect x="60" y="155" width="360" height="360" rx="26"/></clipPath>';
  let body = '<rect width="1200" height="675" rx="38" fill="url(#frame)"/>' +
    '<g clip-path="url(#body)"><rect width="1200" height="675" fill="url(#bg)"/>';
  if (artwork.cover) {
    body += `<image href="data:image/png;base64,${artwork.cover.bytes}" width="1200" height="675" preserveAspectRatio="xMidYMid slice" opacity=".3"/>`;
  }
  body += '<rect width="1200" height="675" fill="url(#grid)" opacity=".5"/><rect width="1200" height="675" fill="url(#glow)"/></g>' +
    '<rect x="26" y="26" width="1148" height="623" rx="18" fill="none" stroke="#F8F5F7" opacity=".2"/>' +
    brandLockup(60, 55, 210) +
    svgText(1136, 88, 16, C.kicker, "PRESALE", { weight: 800, spacing: 0.2, anchor: "end" }) +
    `<rect x="48" y="143" width="384" height="384" rx="38" fill="${S.bezel}" stroke="${C.punch}" stroke-width="3"/>` +
    `<g clip-path="url(#screen)"><rect x="60" y="155" width="360" height="360" fill="${S.screen}"/>`;
  if (artwork.logo) {
    body += `<image href="data:image/png;base64,${artwork.logo.bytes}" x="60" y="155" width="360" height="360" preserveAspectRatio="xMidYMid slice"/>`;
  } else {
    const initials = [...symbol].filter((letter) => /[\p{L}\p{N}]/u.test(letter)).slice(0, 2).join("") || "$";
    body += `<circle cx="240" cy="335" r="130" fill="${C.punch}"/>` +
      svgText(240, 370, 100, C.paper, initials, { weight: 900, anchor: "middle" });
  }
  body += '</g>' + fittedText(486, 255, 58, name, 642) +
    fittedText(486, 322, 36, `$${symbol}`, 642, C.kicker) +
    '<line x1="486" y1="356" x2="1136" y2="356" stroke="#F8F5F7" opacity=".18"/>';
  // Two bounded lines preserve the whole creator-supplied tagline at a readable size.
  const words = tagline.split(/\s+/);
  const lines = [""];
  for (const word of words) {
    if (`${lines[0]} ${word}`.trim().length > 40 && lines.length === 1) lines.push("");
    const last = lines.length - 1;
    lines[last] = `${lines[last]} ${word}`.trim();
  }
  lines.forEach((line, index) => { body += fittedText(486, 405 + index * 40, 26, line, 642); });
  body += svgText(486, 484, 16, C.muted, "RAISED / TARGET", { weight: 800 }) +
    svgText(1136, 484, 22, C.kicker, funding.percentage, { weight: 800, anchor: "end" }) +
    fittedText(486, 524, 32, `${raised} / ${target}`, 642) +
    `<rect x="486" y="544" width="650" height="12" rx="6" fill="${S.bezel}"/>` +
    `<rect x="486" y="544" width="${650 * funding.progress / 100}" height="12" rx="6" fill="${C.punch}"/>`;
  body += svgText(60, 603, 20, C.muted, "blast.fun", { weight: 700 }) +
    svgText(1136, 603, 20, C.paper, "VIEW PRESALE  →", { weight: 800, anchor: "end" });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><defs>${defs}</defs>${body}</svg>`;
}

export async function renderPresaleSharePng(sale: SocialPresaleSummary, artwork: PresaleShareArtwork): Promise<Buffer> {
  const image = await renderAsync(presaleShareSvg(sale, artwork), { font });
  return image.asPng();
}
