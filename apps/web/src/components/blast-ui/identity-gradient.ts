export function identityHue(identity: string): number {
  let hue = 0;
  for (const character of identity) hue = (hue + character.charCodeAt(0)) % 360;
  return hue;
}

/** The same gradient as the wallet avatar, for a coin mark whose image has not decoded yet. */
export function identityBackground(identity: string): string {
  const hue = identityHue(identity);
  return `linear-gradient(135deg, hsl(${hue} 70% 66%), hsl(${(hue + 52) % 360} 64% 50%))`;
}
