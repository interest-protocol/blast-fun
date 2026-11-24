/** Custom observations need no page identifiers; OAuth query/hash data is never sent. */
export function analyticsUrl<Event extends { url: string; type?: string }>(event: Event): Event | null {
  try {
    const url = new URL(event.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (event.type === "event") return { ...event, url: `${url.origin}/_events` };
    url.search = "";
    url.hash = "";
    return { ...event, url: url.toString() };
  } catch {
    return null;
  }
}
