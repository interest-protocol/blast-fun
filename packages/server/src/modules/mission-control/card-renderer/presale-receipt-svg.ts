import { cardAssetPath } from "@blast/server/lib/card-assets.ts";

import { renderAsync } from "@resvg/resvg-js";

import {
  bloomGradient, brandLockup, CARD_GEOMETRY, CARD_PALETTE, helmetMark, linearGradient, r2, roundedRectPath,
  STANDARD_CARD, svgText,
} from "@blast/core/modules/mission-control/card-renderer/card-brand.ts";
import {
  createPresaleReceiptRecord,
  formatQuoteAmount,
  type PresaleReceiptRecord,
} from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import {
  CARD_PNG_HEIGHT, CARD_PNG_WIDTH, CARD_SHARE_HEIGHT, CARD_SHARE_WIDTH, type CardImageFormat,
} from "@blast/server/modules/mission-control/card-renderer/svg.ts";

/*
 * The presale receipt in the Mission Control card's visual language: the
 * standard (non-edition) card's frame, grid, glows, lockup, status pill,
 * monitor with its bezel and scanlines, banner, crew-number type and the
 * countdown strip. Tokens and primitives come from card-brand.ts, which is
 * tested against the season-zero artwork. The monitor shows the sale coin's
 * logo where a card shows the member's photo. The post format sets the card
 * on the x-post layout of the season-zero share image.
 */

const C = { ...CARD_PALETTE, ...STANDARD_CARD, shareInk: "#B8C2CC" } as const;
const { W, H, PX, PY, PS, RX } = CARD_GEOMETRY;
const text = svgText;
const linear = linearGradient;
const bloom = bloomGradient;
const roundedRect = roundedRectPath;
const helmet = helmetMark;
const lockup = (x: number, y: number, w: number) => brandLockup(x, y, w);

/** `value` squeezed into `width` when its estimated advance (Inter, ~0.6 em a glyph) would overflow. */
function fit(value: string, size: number, width: number): number | undefined {
  return [...value].length * size * 0.6 > width ? width : undefined;
}

/** Up to two letters or digits of the coin's symbol, for the monogram mark. */
function initials(record: PresaleReceiptRecord): string {
  return [...record.coinSymbol.toUpperCase()].filter((character) => /[\p{L}\p{N}]/u.test(character)).slice(0, 2).join("");
}

function logoHref(record: PresaleReceiptRecord): string | null {
  return record.logo ? `data:image/png;base64,${record.logo.bytes}` : null;
}

/** The monitor's picture: the coin logo, or its monogram mark (the helmet when the symbol has no letters). */
function screen(record: PresaleReceiptRecord, pre: string): string {
  const href = logoHref(record);
  if (href) {
    return `<image href="${href}" x="${PX}" y="${PY}" width="${PS}" height="${PS}" preserveAspectRatio="xMidYMid slice"/>`;
  }
  const cx = PX + PS / 2;
  const cy = PY + PS / 2;
  const letters = initials(record);
  return `<g id="${pre}monogram"><circle cx="${cx}" cy="${cy}" r="150" fill="${C.punch}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="134" fill="none" stroke="${C.paper}" stroke-width="3" opacity=".3"/>` +
    (letters
      ? text(cx, cy + 44, letters.length > 1 ? 124 : 150, C.paper, letters, { weight: 900, italic: true, spacing: -0.04, anchor: "middle" })
      : helmet(cx - 80, cy - 70, 160, C.paper)) +
    "</g>";
}

/** The card, 1050 x 750 units; `scale` sets its pixel size. */
function cardSvg(record: PresaleReceiptRecord, scale: number, pre: string): string {
  const symbol = `$${record.coinSymbol}`;
  const amount = formatQuoteAmount(record.amountCommitted, record.quoteDecimals);
  const defs = linear(`${pre}frame`, C.frame, 0, 0, 1, 1) + linear(`${pre}bg`, C.bg, 0, 0, 1, 0.5) +
    linear(`${pre}ban`, C.ban, 0, 0, 1, 0) + bloom(`${pre}gl`, 60, 740, 700, C.punch, 0.3) +
    bloom(`${pre}gl2`, 1000, 20, 620, C.glow2, 0.85) +
    `<pattern id="${pre}grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${C.grid}" stroke-width="1"/></pattern>` +
    `<pattern id="${pre}scan" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="2" fill="#000" opacity=".16"/></pattern>` +
    `<radialGradient id="${pre}vig" cx=".5" cy=".5" r=".72"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>` +
    `<linearGradient id="${pre}sheen" x1="0" y1="0" x2="1" y2="1"><stop offset=".30" stop-color="#fff" stop-opacity="0"/><stop offset=".44" stop-color="#fff" stop-opacity=".8"/><stop offset=".52" stop-color="#fff" stop-opacity=".12"/><stop offset=".60" stop-color="#fff" stop-opacity=".55"/><stop offset=".72" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<clipPath id="${pre}clip"><rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="26"/></clipPath>` +
    `<clipPath id="${pre}scr"><rect x="${PX}" y="${PY}" width="${PS}" height="${PS}" rx="34"/></clipPath>` +
    `<clipPath id="${pre}av"><circle cx="604" cy="300" r="27"/></clipPath>`;

  // The body: frame, grid, glows, sheen.
  let s = `<rect width="${W}" height="${H}" rx="38" fill="url(#${pre}frame)"/><g clip-path="url(#${pre}clip)">` +
    `<rect width="${W}" height="${H}" fill="url(#${pre}bg)"/><rect width="${W}" height="${H}" fill="url(#${pre}grid)" opacity=".5"/>` +
    `<rect width="${W}" height="${H}" fill="url(#${pre}gl2)"/><rect width="${W}" height="${H}" fill="url(#${pre}gl)"/></g>` +
    `<path fill-rule="evenodd" fill="url(#${pre}sheen)" opacity=".35" d="${roundedRect(0, 0, W, H, 38)}${roundedRect(14, 14, W - 28, H - 28, 26)}"/>` +
    `<rect x="26" y="26" width="${W - 52}" height="${H - 52}" rx="18" fill="none" stroke="${C.paper}" stroke-width="1.5" opacity=".2"/>`;

  // The header: lockup and status pill.
  s += lockup(52, 50, 192) + `<rect x="798" y="46" width="206" height="44" rx="22" fill="${C.pill}"/>` +
    `<circle cx="822" cy="68" r="6" fill="${C.go}"/><circle cx="822" cy="68" r="11" fill="${C.go}" opacity=".25"/>` +
    text(840, 73, 13, C.paper, "MISSION CONTROL", { weight: 700, spacing: 0.16 });

  // The monitor: the coin's logo on the crew camera.
  s += `<rect x="${PX - 16}" y="${PY - 16}" width="${PS + 32}" height="${PS + 32}" rx="46" fill="${C.bezel}" stroke="${C.punch}" stroke-width="3"/>`;
  for (const [x, y] of [[PX - 2, PY - 2], [PX + PS + 2, PY - 2], [PX - 2, PY + PS + 2], [PX + PS + 2, PY + PS + 2]]) {
    s += `<circle cx="${x}" cy="${y}" r="4" fill="${C.muted}" opacity=".7"/>`;
  }
  const b = 20;
  const L = 32;
  const x0 = PX + b;
  const y0 = PY + b;
  const x1 = PX + PS - b;
  const y1 = PY + PS - b;
  s += `<g clip-path="url(#${pre}scr)"><rect x="${PX}" y="${PY}" width="${PS}" height="${PS}" fill="${C.screen}"/>${screen(record, pre)}` +
    `<rect x="${PX}" y="${PY}" width="${PS}" height="${PS}" fill="url(#${pre}scan)"/><rect x="${PX}" y="${PY}" width="${PS}" height="${PS}" fill="url(#${pre}vig)"/>` +
    `<g fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".9"><path d="M${x0} ${y0 + L}V${y0}H${x0 + L}"/>` +
    `<path d="M${x1 - L} ${y0}H${x1}V${y0 + L}"/><path d="M${x0} ${y1 - L}V${y1}H${x0 + L}"/><path d="M${x1 - L} ${y1}H${x1}V${y1 - L}"/></g>` +
    text(x0 + 14, y0 + 22, 12, "#fff", "CAM 01  ·  PRESALE", { weight: 700, spacing: 0.16 }) +
    `<circle cx="${x1 - 66}" cy="${y0 + 18}" r="5.5" fill="${C.rec}"/>` + text(x1 - 14, y0 + 22, 12, "#fff", "REC", { weight: 700, spacing: 0.16, anchor: "end" }) +
    text(x0 + 14, y1 - 12, 17, "#fff", record.coinName, { weight: 800, spacing: 0.02, length: fit(record.coinName, 17, 240) }) +
    text(x1 - 14, y1 - 12, 12, "#fff", "ON-CHAIN", { weight: 700, spacing: 0.14, anchor: "end" }) + "</g>";
  const stamp = "COMMITTED";
  const stampWidth = stamp.length * 16 + 40;
  s += `<g transform="rotate(-8 ${PX + PS - 140} ${PY + PS - 64})"><rect x="${r2(PX + PS - 18 - stampWidth)}" y="${PY + PS - 104}" width="${stampWidth}" height="54" rx="9" fill="rgba(10,15,22,.72)" stroke="${C.go}" stroke-width="4"/>` +
    text(PX + PS - 18 - stampWidth / 2, PY + PS - 68, 22, C.go, stamp, { weight: 900, spacing: 0.08, anchor: "middle" }) + "</g>";

  // The right column: the sale, the coin, the amount, the crew.
  s += text(RX, 150, 15, C.kicker, "PRESALE RECEIPT", { weight: 700, spacing: 0.2 });
  const banner = record.coinName.toUpperCase();
  const bannerSize = [...banner].length > 16 ? 40 : [...banner].length > 12 ? 46 : 52;
  const by = 168;
  s += `<path fill="rgba(3,3,7,.68)" d="M${RX + 18} ${by}H${W - 14}V${by + 72}H${RX}z"/>` +
    `<path fill="url(#${pre}ban)" d="M${RX + 18} ${by}H${RX + 34}L${RX + 16} ${by + 72}H${RX}z"/>` +
    `<path fill="url(#${pre}ban)" d="M${RX + 18} ${by}H${W - 14}V${by + 3}H${RX + 17.25}z"/><path fill="url(#${pre}ban)" d="M${RX + 0.75} ${by + 69}H${W - 14}V${by + 72}H${RX}z"/>` +
    text(RX + 44, by + 37 + bannerSize * 0.35, bannerSize, "#FFFFFF", banner, {
      weight: 900, italic: true, spacing: -0.035, length: Math.min(390, [...banner].length * bannerSize * 0.6),
    });
  const href = logoHref(record);
  s += `<circle cx="604" cy="300" r="31" fill="url(#${pre}frame)"/>` + (href
    ? `<image href="${href}" x="577" y="273" width="54" height="54" preserveAspectRatio="xMidYMid slice" clip-path="url(#${pre}av)"/>`
    : `<circle cx="604" cy="300" r="27" fill="${C.punch}"/>` + text(604, 309, 22, C.paper, initials(record).slice(0, 1) || "$", { weight: 900, anchor: "middle" }));
  s += text(650, 313, 34, C.paper, symbol, { weight: 800, spacing: -0.025, length: fit(symbol, 34, 354) });
  s += `<line x1="${RX}" y1="354" x2="1004" y2="354" stroke="${C.paper}" stroke-width="1.5" opacity=".18"/>`;
  s += text(RX, 392, 13, C.muted, "AMOUNT COMMITTED", { weight: 800, spacing: 0.22 });
  const amountSize = amount.length > 11 ? 56 : amount.length > 8 ? 68 : 84;
  const amountLength = fit(amount, amountSize, 428);
  s += text(RX, 475, amountSize, "#000", amount, { weight: 900, italic: true, spacing: -0.04, opacity: 0.45, length: amountLength }) +
    text(RX - 4, 470, amountSize, "#FFFFFF", amount, { weight: 900, italic: true, spacing: -0.04, length: amountLength });
  s += text(RX, 512, 22, C.kicker, record.quoteSymbol, { weight: 800, spacing: 0.08 });
  if (record.crew !== null) {
    s += text(RX, 566, 13, C.muted, "CREW NO.", { weight: 800, spacing: 0.22 }) +
      text(RX + 100, 570, 28, "#FFFFFF", `#${String(record.crew).padStart(4, "0")}`, { weight: 900, italic: true, spacing: -0.02 });
  }

  // The countdown along the foot, its last cell lit.
  ["T−5", "T−4", "T−3", "T−2", "T−1", "COMMITTED"].forEach((label, index) => {
    const width = 151;
    const x = 48 + index * (width + 10);
    const lit = index === 5;
    s += `<rect x="${x}" y="640" width="${width}" height="34" rx="7" fill="${lit ? C.go : C.stripFill}" stroke="${C.go}" stroke-opacity="${lit ? 1 : 0.6}"/>` +
      text(x + width / 2, 662, lit ? 12 : 11.5, lit ? "#07070D" : C.stripText, label, { weight: lit ? 900 : 800, spacing: 0.08, anchor: "middle", italic: lit });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${s}</svg>`;
}

/** The X post, 1200 x 675: the card, tilted, on the card's dark grid, and the receipt text on the right. */
function postSvg(record: PresaleReceiptRecord, pre: string): string {
  const SW = CARD_SHARE_WIDTH;
  const SH = CARD_SHARE_HEIGHT;
  const card = cardSvg(record, 1, `${pre}c-`);
  const inner = card.slice(card.indexOf(">") + 1, card.lastIndexOf("</svg>"));
  const cw = 760;
  const ch = (cw * H) / W;
  const cx = 46;
  const cy = (SH - ch) / 2 + 6;
  const k = cw / W;
  const tx = 846;
  const amount = `${formatQuoteAmount(record.amountCommitted, record.quoteDecimals)} ${record.quoteSymbol}`;
  const amountSize = [...amount].length > 9 ? 44 : 62;
  const defs = `<g id="${pre}card">${inner}</g>` +
    `<pattern id="${pre}grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${C.grid}" stroke-width="1"/></pattern>` +
    bloom(`${pre}gl`, 220, 640, 760, C.punch, 0.32) + bloom(`${pre}gl2`, 1180, 0, 640, C.kicker, 0.14);
  let s = `<rect width="${SW}" height="${SH}" fill="#05060A"/><rect width="${SW}" height="${SH}" fill="url(#${pre}grid)" opacity=".6"/>` +
    `<rect width="${SW}" height="${SH}" fill="url(#${pre}gl)"/><rect width="${SW}" height="${SH}" fill="url(#${pre}gl2)"/>`;
  s += `<g transform="rotate(-3 ${r2(cx + cw / 2)} ${r2(cy + ch / 2)})">` +
    `<rect x="${cx + 6}" y="${r2(cy + 18)}" width="${cw}" height="${r2(ch)}" rx="${r2(38 * k)}" fill="#000" opacity=".45"/>` +
    `<use href="#${pre}card" transform="translate(${r2(cx)} ${r2(cy)}) scale(${r2(k)})"/></g>`;
  s += lockup(tx, 92, 150) +
    text(tx, 210, 13, C.kicker, `PRESALE  ·  $${record.coinSymbol}`, { weight: 800, spacing: 0.14, length: fit(`PRESALE  ·  $${record.coinSymbol}`, 13, 318) }) +
    text(tx - 3, 292, 62, C.paper, "Committed", { weight: 900, italic: true, spacing: -0.045 }) +
    text(tx - 3, 356, amountSize, C.punch, amount, { weight: 900, italic: true, spacing: -0.045, length: fit(amount, amountSize, 318) }) +
    text(tx, 414, 22, C.paper, record.coinName, { weight: 800, spacing: -0.01, length: fit(record.coinName, 22, 318) }) +
    (record.crew === null ? "" : text(tx, 444, 17, C.shareInk, `Crew #${String(record.crew).padStart(4, "0")}`, { weight: 500 })) +
    `<rect x="${tx}" y="510" width="232" height="50" rx="8" fill="${C.punch}"/>` +
    text(tx + 116, 542, 17, C.canvas, "Join the presale", { weight: 700, anchor: "middle" }) +
    text(tx, 600, 16, C.shareInk, "blast.fun", { weight: 600 });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}" viewBox="0 0 ${SW} ${SH}"><defs>${defs}</defs>${s}</svg>`;
}

/** The receipt as SVG: `card` is the 2100 x 1500 card, `share` the 1200 x 675 X post (route format `post`). */
export function renderPresaleReceiptSvg(input: PresaleReceiptRecord, format: CardImageFormat): string {
  const record = createPresaleReceiptRecord(input);
  return format === "share" ? postSvg(record, "prs-") : cardSvg(record, 2, "pr-");
}

export interface RenderedPresaleReceipt {
  readonly contentType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: Buffer;
}

/** Pure and deterministic: the same record and format always give the same PNG bytes. */
export async function renderPresaleReceiptPng(input: PresaleReceiptRecord, format: CardImageFormat): Promise<RenderedPresaleReceipt> {
  const svg = renderPresaleReceiptSvg(input, format);
  const image = await renderAsync(svg, {
    font: {
      // Explicit font files, as for season-zero cards: no system fonts on serverless hosts.
      loadSystemFonts: false,
      defaultFontFamily: "Inter",
      fontFiles: ["Medium", "SemiBold", "Bold", "ExtraBold", "Black", "BoldItalic", "ExtraBoldItalic", "BlackItalic"]
        .map((weight) => cardAssetPath(`fonts/Inter-${weight}.ttf`)),
    },
  });
  return Object.freeze({
    contentType: "image/png",
    width: format === "share" ? CARD_SHARE_WIDTH : CARD_PNG_WIDTH,
    height: format === "share" ? CARD_SHARE_HEIGHT : CARD_PNG_HEIGHT,
    bytes: image.asPng(),
  });
}
