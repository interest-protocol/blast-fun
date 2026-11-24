export function ownerCardFilename(callsign: string): string {
  return `blast-season-zero-${callsign}.png`;
}

export function ownerCardShareIntent(cardUrl: string): string {
  const intent = new URL("https://x.com/intent/post");
  intent.searchParams.set("url", cardUrl);
  return intent.href;
}
