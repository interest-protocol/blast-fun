import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { HOME_DEFAULT_VIEW, hasHomeViewSearch, viewSearchOf, viewStateOf, type HomeViewState } from "./home-state.ts";

const STORAGE_KEY = "blast.homeFilters.v1";

function filterSearchOf(state: HomeViewState): string {
  return viewSearchOf({ ...state, source: HOME_DEFAULT_VIEW.source, page: HOME_DEFAULT_VIEW.page });
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
  const search = filterSearchOf(viewStateOf(new URLSearchParams(saved)));
  if (!search) {
    return null;
  }

  const restored = new URL(url);
  for (const [key, value] of new URLSearchParams(search)) {
    restored.searchParams.set(key, value);
  }
  return restored;
}
