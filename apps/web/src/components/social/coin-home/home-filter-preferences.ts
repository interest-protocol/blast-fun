import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { HOME_DEFAULT_FEED, HOME_DEFAULT_VIEW, hasHomeViewSearch, viewSearchOf, viewStateOf, type HomeViewState } from "./home-state.ts";

const STORAGE_KEY = "blast.homeFilters.v1";

/**
 * The saved part of a view: its filters and window, never its tab, so a bare
 * Home always opens on Closest to graduating (Jose, 2026-11-28). A URL that
 * names a tab, such as a shared link or Back, still opens that tab.
 */
function filterSearchOf(state: HomeViewState): string {
  return viewSearchOf({
    ...state,
    source: HOME_DEFAULT_VIEW.source,
    page: HOME_DEFAULT_VIEW.page,
    stage: HOME_DEFAULT_FEED.stage,
    sort: HOME_DEFAULT_FEED.sort,
  });
}

export function rememberHomeFilters(current: HomeViewState, next: HomeViewState): void {
  const search = filterSearchOf(next);
  if (search !== filterSearchOf(current)) {
    writeBrowserStorage("local", STORAGE_KEY, search);
  }
}

export function restoreHomeFilters(url: URL): URL | null {
  if (hasHomeViewSearch(url.searchParams)) {
    return null;
  }
  const saved = readBrowserStorage("local", STORAGE_KEY);
  if (!saved) {
    return null;
  }
  const params = new URLSearchParams(saved);
  params.delete("page");
  const search = filterSearchOf(viewStateOf(params));
  if (!search) {
    return null;
  }

  const restored = new URL(url);
  for (const [key, value] of new URLSearchParams(search)) {
    restored.searchParams.set(key, value);
  }
  return restored;
}
