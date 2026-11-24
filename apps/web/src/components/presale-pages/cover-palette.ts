/** Canonical presale IDs select the same muted cover on the server and client. */
export function coverPalette(presaleId?: string | null): number {
  if (!presaleId) return 0;
  let hash = 0;
  for (const char of presaleId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return 1 + hash % 4;
}
