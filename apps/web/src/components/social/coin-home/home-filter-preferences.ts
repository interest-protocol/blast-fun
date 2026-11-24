import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { HOME_DEFAULT_VIEW, hasHomeViewSearch, viewSearchOf, viewStateOf, type HomeFeedState } from "./home-state.ts";

const STORAGE_KEY = "blast.homeFilters.v1";

function filterSearchOf(state: HomeFeedState): string {
  return viewSearchOf({ ...state, source: HOME_DEFAULT_VIEW.source, page: HOME_DEFAULT_VIEW.page });
}

export function rememberHomeFilters(current: HomeFeedState, next: HomeFeedState): void {
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
