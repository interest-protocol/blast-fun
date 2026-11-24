import QRCode, { type QRCodeMaskPattern } from "qrcode";

/** UTF-8 byte mode, level M, versions 1–10; the library chooses the lowest-penalty mask. */
export function qrMatrix(text: string, forcedMask?: number): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 213) throw new RangeError("Too long for a QR code here.");
  const { modules } = QRCode.create([{ data: bytes, mode: "byte" }], { errorCorrectionLevel: "M", maskPattern: forcedMask as QRCodeMaskPattern | undefined });
  return Array.from({ length: modules.size }, (_, y) =>
    Array.from({ length: modules.size }, (_, x) => modules.get(y, x) === 1));
}
