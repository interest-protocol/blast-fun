import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderAsync, Resvg } from "@resvg/resvg-js";
import { brandLockup, CARD_PALETTE, svgText } from "@blast/core/modules/mission-control/card-renderer/card-brand.ts";
import { createPresaleReceiptLogo, PRESALE_RECEIPT_LOGO_SIZE, type PresaleReceiptLogo } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { blastV1Coin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { cachedCoinLogo, fetchCoinLogo } from "@blast/server/modules/presale/receipts/logo.ts";
import { COIN_SHARE_HEIGHT, COIN_SHARE_WIDTH } from "./share.ts";

const logoFor = cachedCoinLogo(fetchCoinLogo, { maxBytes: 4 * 1024 * 1024 });
const builtInLogos = new Map([[SUI_COIN_TYPE, "sui"], [USDC_COIN_TYPE, "usdc"]]);
const assets = resolve(process.cwd(), "../../packages/server/assets");
const font = {
  loadSystemFonts: false,
  defaultFontFamily: "Inter",
  fontFiles: ["Bold", "ExtraBold", "Black"].map((weight) => resolve(assets, `mission-control/fonts/Inter-${weight}.ttf`)),
};

export async function coinShareLogo(coin: { coinType: string | null; iconUrl: string | null }) {
  const legacy = coin.coinType && blastV1Coin(coin.coinType);
  if (legacy) {
    const { default: sharp } = await import("sharp");
    const path = resolve("public", `.${legacy.logoUrl}`);
    const png = await sharp(path)
      .resize(PRESALE_RECEIPT_LOGO_SIZE, PRESALE_RECEIPT_LOGO_SIZE)
      .png()
      .toBuffer();
    return { logo: createPresaleReceiptLogo(png), transient: false };
  }
  const builtIn = coin.coinType && builtInLogos.get(coin.coinType);
  if (!builtIn) return logoFor(coin.iconUrl);
  const svg = await readFile(resolve("public/blast-ui/coins", `${builtIn}.svg`));
  const raster = await renderAsync(svg, { fitTo: { mode: "width", value: PRESALE_RECEIPT_LOGO_SIZE } });
  return { logo: createPresaleReceiptLogo(raster.asPng()), transient: false };
}

export async function renderCoinShareImage(coin: { name: string; symbol: string }, logo: PresaleReceiptLogo | null) {
  const background = await readFile(resolve(assets, "launchpad/coin-share-background.jpg"), "base64");
  const name = cardText(coin.name, 40);
  const symbol = cardText(coin.symbol, 24).replace(/^\$+/, "");
  const initials = [...symbol].filter((letter) => /[\p{L}\p{N}]/u.test(letter)).slice(0, 2).join("") || "$";
  const icon = logo
    ? `<image href="data:image/png;base64,${logo.bytes}" x="124" y="145" width="356" height="356" clip-path="url(#icon)"/>`
    : svgText(302, 361, 108, CARD_PALETTE.punch, initials, { weight: 900, anchor: "middle" });
  const svg = canvas(
    `<defs><clipPath id="icon"><circle cx="302" cy="323" r="178"/></clipPath></defs>` +
    `<image href="data:image/jpeg;base64,${background}" width="${COIN_SHARE_WIDTH}" height="${COIN_SHARE_HEIGHT}"/>` +
    icon + `<circle cx="302" cy="323" r="178" fill="none" stroke="${CARD_PALETTE.punch}" stroke-width="4"/>` +
    brandLockup(566, 154, 172) +
    fittedText(330, 82, CARD_PALETTE.paper, name) +
    fittedText(414, 48, CARD_PALETTE.punch, `$${symbol}`),
  );
  return (await renderAsync(svg, { font })).asPng();
}

function cardText(value: string, limit: number): string {
  const characters = [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : characters.join("");
}

function canvas(body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${COIN_SHARE_WIDTH}" height="${COIN_SHARE_HEIGHT}">${body}</svg>`;
}

function fittedText(y: number, size: number, fill: string, value: string) {
  const x = 566;
  const width = 566;
  const options = { weight: 800 };
  const text = svgText(x, y, size, fill, value, options);
  const bounds = new Resvg(canvas(text), { font }).getBBox();
  if (!bounds || bounds.x + bounds.width <= x + width) return text;
  const fittedSize = Math.floor(size * width / (bounds.x + bounds.width - x));
  return svgText(x, y, fittedSize, fill, value, options);
}
