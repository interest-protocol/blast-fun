import type { PnlAsset, PnlFigures } from "@blast/core/web/contracts/pnl.ts";
import { referralCallsign, referralPath } from "@blast/core/modules/social/referrals/contracts.ts";
import { brandLockup, helmetMark, svgText } from "@blast/core/web/card-brand.ts";
import { canCreatePnlCard, pnlFigure } from "./pnl-model.ts";

export type PnlCard = Readonly<{
  callsign: string;
  figures: PnlFigures;
  asset?: PnlAsset;
}>;

export const PNL_CARD_MEMES = [
  { value: "auto", label: "Match my PnL" },
  { value: "printer", label: "Money printer go brrr" },
  { value: "cook", label: "Let them cook" },
  { value: "fine", label: "This is fine" },
  { value: "last", label: "This is the last time · Death" },
  { value: "diamond", label: "Diamond hands" },
  { value: "tuition", label: "Market tuition paid" },
] as const;
export type PnlCardMeme = typeof PNL_CARD_MEMES[number]["value"];

const MEME_INK = { paper: "#30212B", muted: "#806372", punch: "#FF4C98", kicker: "#A63869", up: "#117A43", down: "#D32F45", word: "#FF4C98", veil: true };
const NIGHT_INK = { paper: "#F8F5F7", muted: "#C1B5C8", punch: "#FF4C98", kicker: "#EFA1C9", up: "#81CBA5", down: "#FF8DA6", word: "#F8F5F7", veil: false };
const PINK_INK = { ...MEME_INK, paper: "#0D1117", muted: "#260D1B", punch: "#0D1117", kicker: "#260D1B", up: "#064829", down: "#65112E", word: "#0D1117", veil: false };

export const PNL_CARD_TEMPLATES = [
  { value: "flight-report", label: "Flight report", artwork: "/social/pnl-flight-report.svg", ink: NIGHT_INK, tone: null },
  { value: "afterburner", label: "Afterburner", artwork: "/social/pnl-afterburner.svg", ink: NIGHT_INK, tone: null },
  { value: "full-blast", label: "Full blast", artwork: "/social/pnl-full-blast.svg", ink: PINK_INK, tone: null },
  { value: "launch-pad", label: "Launch pad", artwork: "/social/pnl-launch-pad.svg", ink: NIGHT_INK, tone: null },
  { value: "helmet-grid", label: "Helmet grid", artwork: "/social/pnl-helmet-grid.svg", ink: NIGHT_INK, tone: null },
  { value: "soft-landing", label: "Soft landing", artwork: "/social/pnl-soft-landing.svg", ink: { ...MEME_INK, veil: false }, tone: null },
  { value: "money-printer", label: "Money printer", artwork: "/social/pnl-gain-meme.webp", ink: MEME_INK, tone: "up" },
  { value: "this-is-fine", label: "This is fine", artwork: "/social/pnl-loss-meme.webp", ink: MEME_INK, tone: "down" },
  { value: "death", label: "This is the last time · Death", artwork: "/social/pnl-death-meme.webp", ink: MEME_INK, tone: "down" },
] as const;
export type PnlCardTemplate = typeof PNL_CARD_TEMPLATES[number]["value"];
export type PnlCardStyle = Readonly<{ meme: PnlCardMeme; template?: PnlCardTemplate; image?: string; coinIcon?: string }>;

export function pnlCardTemplates(card: PnlCard) {
  const tone = pnlFigure(card.figures.total_usd).tone;
  return PNL_CARD_TEMPLATES.filter((template) => template.tone === null || template.tone === tone);
}

export function defaultPnlCardTemplate(card: PnlCard): PnlCardTemplate {
  const tone = pnlFigure(card.figures.total_usd).tone;
  if (tone === "up") return "money-printer";
  return tone === "down" ? "this-is-fine" : "flight-report";
}

function cardTemplate(card: PnlCard, style: PnlCardStyle) {
  const value = style.template ?? (style.meme === "last" ? "death" : defaultPnlCardTemplate(card));
  const template = pnlCardTemplates(card).find((option) => option.value === value);
  if (!template) throw new Error("This design is unavailable for this PnL.");
  return template;
}

function cardMeme(tone: "up" | "down" | null, template: PnlCardTemplate, meme: PnlCardMeme) {
  if (meme !== "auto") return meme;
  if (template === "death") return "last";
  if (tone === "down") return "fine";
  return tone === "up" ? "printer" : "even";
}

const MEME_CAPTIONS = {
  printer: "MONEY PRINTER GO BRRR.",
  cook: "LET THEM COOK.",
  fine: "THIS IS FINE.",
  last: "This is the last time.",
  diamond: "DIAMOND HANDS.",
  tuition: "MARKET TUITION PAID.",
  even: "EVEN STEVEN.",
};

const C = { canvas: "#FFFFFF", paper: "#30212B", muted: "#806372", punch: "#FF4C98", kicker: "#A63869", up: "#117A43", down: "#D32F45" };

export function pnlCardDescription({ callsign, figures, asset }: PnlCard): string {
  return `@${callsign} · ${asset ? `$${asset.symbol}` : "Account"} PnL since launch ${pnlFigure(figures.total_usd).text}.${asset?.tracked_balance === "0" ? " Closed position." : ""}`;
}

/** Social artwork stays focused on the result; the profile holds the accounting detail. */
export function pnlCardSvg(card: PnlCard, style: PnlCardStyle = { meme: "auto" }): string {
  if (!canCreatePnlCard(card.figures)) throw new Error("PnL is incomplete. Wait for prices and history to update.");
  if ([style.image, style.coinIcon].some((image) => image !== undefined && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image))) throw new Error("Use a prepared card image.");
  const total = pnlFigure(card.figures.total_usd);
  const template = cardTemplate(card, style);
  const ink = style.image && !style.template ? MEME_INK : template.ink;
  const artwork = style.image ?? template.artwork;
  const resultColor = ink[total.tone ?? "paper"];
  const meme = cardMeme(total.tone, template.value, style.meme);
  const headline = MEME_CAPTIONS[meme];
  const title = card.asset ? `$${card.asset.symbol}` : "ACCOUNT PnL";
  const callsign = referralCallsign(card.callsign);
  const text = (x: number, y: number, size: number, fill: string, value: string, width = 1060) => svgText(x, y, size, fill, value, {
    weight: 700, length: [...value].length * size * 0.65 > width ? width : undefined,
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
    <defs><clipPath id="coin-icon"><circle cx="96" cy="200" r="32"/></clipPath><linearGradient id="readability" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".94"/><stop offset=".34" stop-color="#FFFFFF" stop-opacity=".86"/><stop offset=".54" stop-color="#FFFFFF" stop-opacity=".4"/><stop offset=".72" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient></defs>
    <rect width="1200" height="675" fill="${C.canvas}"/>
    ${artwork ? `<image href="${artwork}" x="0" y="0" width="1200" height="675" preserveAspectRatio="xMidYMid slice"/>` : `
      <circle cx="918" cy="372" r="280" fill="${C.punch}" fill-opacity=".12"/>
      ${helmetMark(764, 218, 308, C.punch)}
    `}
    ${ink.veil ? '<rect width="1200" height="675" fill="url(#readability)"/>' : ""}
    ${brandLockup(64, 54, 240, ink.punch, ink.word)}
    ${text(64, 143, 24, ink.muted, `@${card.callsign}`, 580)}
    ${coinMark(card.asset, style.coinIcon)}
    ${text(card.asset ? 144 : 64, card.asset ? 210 : 204, 28, ink.paper, title, card.asset ? 500 : 580)}
    ${text(64, 254, 20, ink.kicker, `PnL SINCE LAUNCH${card.asset?.tracked_balance === "0" ? " · CLOSED" : ""}`, 580)}
    ${text(64, 374, 96, resultColor, total.text, 580)}
    ${text(64, 496, 34, ink.kicker, headline, 580)}
    ${meme === "last" ? text(64, 538, 24, ink.kicker, "sayin it since $MELANIA", 580) : ""}
    ${text(64, 610, 20, ink.muted, callsign ? `blast.fun${referralPath(callsign)}` : "blast.fun")}
  </svg>`;
}

function coinMark(asset: PnlAsset | undefined, icon: string | undefined): string {
  if (!asset) return "";
  const image = icon
    ? `<image href="${icon}" x="64" y="168" width="64" height="64" preserveAspectRatio="xMidYMid meet" clip-path="url(#coin-icon)"/>`
    : svgText(96, 210, 28, C.kicker, [...asset.symbol][0]?.toUpperCase() ?? "?", { weight: 700, anchor: "middle" });
  return `<circle cx="96" cy="200" r="33" fill="#FFFFFF" stroke="#FFC7DF" stroke-width="2"/>${image}`;
}

async function prepareImage(source: string, maxSize = 1024, timeoutMs?: number): Promise<string> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.referrerPolicy = "no-referrer";
  image.src = source;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs) {
      await Promise.race([image.decode(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { image.src = ""; reject(new Error("Image took too long to load.")); }, timeoutMs);
      })]);
    } else {
      await image.decode();
    }
  } finally {
    clearTimeout(timeout);
  }
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error("Image dimensions are too large.");
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image could not render.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/** Icons from metadata may be unavailable or disallow CORS; keep the card usable. */
async function prepareCoinIcon(source: string | null | undefined): Promise<string | undefined> {
  if (!source || !/^(https:\/\/|\/(?!\/)|data:image\/(png|jpeg|webp|svg\+xml)[;,])/.test(source)) return undefined;
  try {
    return await prepareImage(source, 128, 5_000);
  } catch {
    return undefined;
  }
}

/** Embed artwork and coin icons so downloaded PNGs are self-contained. */
export async function pnlCardPng(card: PnlCard, style: PnlCardStyle = { meme: "auto" }): Promise<Blob> {
  if (!canCreatePnlCard(card.figures)) throw new Error("PnL is incomplete. Wait for prices and history to update.");
  const template = cardTemplate(card, style);
  const inkTemplate = style.image ? undefined : template.value;
  const meme = style.meme === "auto" && template.value === "death" ? "last" : style.meme;
  const [artwork, coinIcon] = await Promise.all([
    style.image ?? prepareImage(template.artwork),
    style.coinIcon ?? prepareCoinIcon(card.asset?.icon_url),
  ]);
  const svg = pnlCardSvg(card, { ...style, meme, template: inkTemplate, image: artwork, coinIcon });
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 675;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Card could not render. Try again.");
  context.drawImage(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error("Card could not render. Try again."));
  }, "image/png"));
}
