/**
 * Which page numbers the pager draws: every page up to seven; past that the
 * first, the last, the current one with a neighbour each side, and a gap
 * (`null`) where pages are skipped.
 */
export function pageItems(page: number, pages: number): readonly (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  const around = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  if (page <= 3) [2, 3, 4].forEach((n) => around.add(n));
  if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((n) => around.add(n));
  const sorted = [...around].sort((a, b) => a - b);
  const items: (number | null)[] = [];
  sorted.forEach((n, index) => {
    const previous = sorted[index - 1];
    if (previous !== undefined && n - previous > 1) items.push(null);
    items.push(n);
  });
  return items;
}
