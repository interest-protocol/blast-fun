import type { SocialPresaleListPage } from "@blast/core/web/contracts/presales.ts";

/** Calendar counts cover every page, rather than the first 50 sales. */
export async function readCalendarPages(read: (cursor: string | null) => Promise<SocialPresaleListPage>): Promise<SocialPresaleListPage> {
  const first = await read(null);
  const presales = [...first.presales];
  const seen = new Set<string>();
  let cursor = first.next_cursor;
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error("Calendar pagination did not advance");
    seen.add(cursor);
    const page = await read(cursor);
    presales.push(...page.presales);
    cursor = page.next_cursor;
  }
  return { ...first, presales, next_cursor: null };
}
