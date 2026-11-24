import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  DEFAULT_SHELL_PREFS,
  nextTheme,
  readShellPrefs,
  SHELL_PREF_KEYS,
  SHELL_PREFS_BOOT_SCRIPT,
  shellPrefAttributes,
  restoreThemeColor,
  shellPrefsFromAttributes,
  syncThemeColor,
  THEME_COLOR,
  themeLabel,
  writeShellPref,
  type PrefStorage,
} from "./prefs.ts";

function memory(entries: Record<string, string> = {}): PrefStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(entries));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

/** Runs the serialised boot script against a fake root, as the browser does before the first paint. */
function boot(storage: PrefStorage | null, width: number): Map<string, string> {
  const attributes = new Map<string, string>([["data-theme", "stale"]]);
  const root = {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  };
  const window = {
    innerWidth: width,
    get localStorage() {
      if (storage === null) throw new Error("SecurityError");
      return storage;
    },
  };
  runInNewContext(SHELL_PREFS_BOOT_SCRIPT, { window, document: { currentScript: { parentElement: root } } });
  return attributes;
}

test("UI-01: a first visit starts with the rail collapsed under 1400px and expanded from 1400px", () => {
  assert.equal(readShellPrefs(memory(), 1399).railMini, true);
  assert.equal(readShellPrefs(memory(), 1400).railMini, false);
  assert.deepEqual(readShellPrefs(null, 1440), DEFAULT_SHELL_PREFS);
});

test("UI-01: the rail's remembered choice wins over the viewport, either way", () => {
  const storage = memory();
  writeShellPref(storage, "railMini", false);
  assert.equal(storage.data.get(SHELL_PREF_KEYS.railMini), "false");
  assert.equal(readShellPrefs(storage, 390).railMini, false);
  writeShellPref(storage, "railMini", true);
  assert.equal(readShellPrefs(storage, 1920).railMini, true);
});

test("UI-01: the theme persists per device as the prototype stores it (blast.theme, JSON), and junk reads as system", () => {
  const storage = memory();
  for (const theme of ["light", "dark", "system"] as const) {
    writeShellPref(storage, "theme", theme);
    assert.equal(storage.data.get("blast.theme"), JSON.stringify(theme));
    assert.equal(readShellPrefs(storage, 1440).theme, theme);
  }
  for (const junk of ["sepia", "{", "1", '"Dark"']) assert.equal(readShellPrefs(memory({ "blast.theme": junk }), 1440).theme, "system", junk);
});

test("UI-01: the privacy eye and the right column's collapse are remembered; anything but true is off", () => {
  const storage = memory();
  writeShellPref(storage, "amountsHidden", true);
  writeShellPref(storage, "asideCollapsed", true);
  assert.deepEqual(readShellPrefs(storage, 1440), { theme: "system", railMini: false, asideCollapsed: true, amountsHidden: true, hideSmallBalances: true, recapPinned: false });
  assert.equal(readShellPrefs(memory({ "blast.hideBal": '"true"', "blast.collapsed": "1" }), 1440).amountsHidden, false);
  assert.equal(readShellPrefs(memory({ "blast.collapsed": "1" }), 1440).asideCollapsed, false);
});

test("UI-01: storage that refuses writes never throws (the page keeps the value in memory)", () => {
  const refusing: PrefStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.doesNotThrow(() => writeShellPref(refusing, "theme", "dark"));
  assert.deepEqual(readShellPrefs(refusing, 1440), DEFAULT_SHELL_PREFS);
});

test("UI-01: the root's attributes carry the preferences; system leaves data-theme off so prefers-color-scheme decides", () => {
  assert.deepEqual(shellPrefAttributes(DEFAULT_SHELL_PREFS), {
    "data-theme": null,
    "data-theme-setting": "system",
    "data-rail": "full",
    "data-aside": "open",
    "data-amounts": "shown",
    "data-small-balances": "hidden",
    "data-recap": "free",
  });
  const prefs = { theme: "dark", railMini: true, asideCollapsed: true, amountsHidden: true, hideSmallBalances: true, recapPinned: true } as const;
  const attributes = shellPrefAttributes(prefs);
  assert.equal(attributes["data-theme"], "dark");
  assert.deepEqual(shellPrefsFromAttributes((name) => attributes[name] ?? null), prefs);
});

test("UI-01: the boot script (no flash) applies exactly what readShellPrefs reads, for every stored combination", () => {
  const cases = [undefined, '\"light\"', '\"dark\"', '\"system\"', "junk"].flatMap((theme) =>
    [undefined, "true", "false"].flatMap((rail) => [390, 1024, 1440].map((width) => ({ theme, rail, width }))));
  for (const { theme, rail, width } of cases) {
    const entries: Record<string, string> = { "blast.collapsed": "true", "blast.hideBal": "false", "blast.recapPin": width === 1024 ? "true" : "1" };
    if (theme) entries["blast.theme"] = theme;
    if (rail) entries["blast.railMini"] = rail;
    const storage = memory(entries);
    const expected = Object.entries(shellPrefAttributes(readShellPrefs(storage, width))).filter(([, value]) => value !== null);
    assert.deepEqual(Object.fromEntries(boot(storage, width)), Object.fromEntries(expected), `${theme} ${rail} ${width}`);
  }
  // Blocked storage: the defaults for the width, and a stale data-theme is removed.
  assert.deepEqual(Object.fromEntries(boot(null, 1024)), Object.fromEntries(
    Object.entries(shellPrefAttributes(readShellPrefs(null, 1024))).filter(([, value]) => value !== null),
  ));
});

test("UI-01: the account menu's Appearance cycles System → Light → Dark → System and reads the setting's name", () => {
  assert.equal(nextTheme("system"), "light");
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("dark"), "system");
  assert.deepEqual(["system", "light", "dark"].map((theme) => themeLabel(theme as "system")), ["System", "Light", "Dark"]);
});

/** A `<meta name="theme-color">` as the sync reads and writes it. */
function fakeMeta(content: string) {
  return { content, dataset: {} as Record<string, string | undefined> };
}

/** A document holding `metas`, as the only thing the sync queries. */
function fakeDoc(metas: ReturnType<typeof fakeMeta>[]) {
  return { querySelectorAll: (selector: string) => (selector === 'meta[name="theme-color"]' ? metas : []) } as unknown as Document;
}

test("R3-02: the status bar follows the chosen theme, and the page's own colour comes back after", () => {
  const meta = fakeMeta("#10171e");
  const doc = fakeDoc([meta]);
  syncThemeColor(doc, "dark", false);
  assert.equal(meta.content, THEME_COLOR.dark);
  assert.equal(meta.dataset.blastThemeColor, "#10171e", "the launchpad's colour is remembered once");
  syncThemeColor(doc, "light", true);
  assert.equal(meta.content, THEME_COLOR.light, "the choice wins over the system scheme");
  syncThemeColor(doc, "system", true);
  assert.equal(meta.content, THEME_COLOR.dark, "system follows prefers-color-scheme");
  syncThemeColor(doc, "system", false);
  assert.equal(meta.content, THEME_COLOR.light);
  assert.equal(meta.dataset.blastThemeColor, "#10171e", "still the first colour, not an overwritten one");
  restoreThemeColor(doc);
  assert.equal(meta.content, "#10171e");
  assert.equal(meta.dataset.blastThemeColor, undefined);
  assert.doesNotThrow(() => restoreThemeColor(doc), "a document already given back is left alone");
  assert.equal(meta.content, "#10171e");
  assert.deepEqual(THEME_COLOR, { light: "#f4f3f7", dark: "#0b0a0f" }, "the two page backgrounds, as the reference's metas carry them");
});

test("R3-02: the boot script sets the status bar before the first paint, for every theme", () => {
  for (const [stored, systemDark, expected] of [
    ['"dark"', false, THEME_COLOR.dark],
    ['"light"', true, THEME_COLOR.light],
    ['"system"', true, THEME_COLOR.dark],
    ['"system"', false, THEME_COLOR.light],
    [undefined, true, THEME_COLOR.dark],
  ] as const) {
    const meta = fakeMeta("#10171e");
    const attributes = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
      ownerDocument: fakeDoc([meta]),
    };
    const entries = new Map<string, string>(stored ? [["blast.theme", stored]] : []);
    const window = { innerWidth: 1440, localStorage: { getItem: (key: string) => entries.get(key) ?? null, setItem: () => undefined } };
    runInNewContext(SHELL_PREFS_BOOT_SCRIPT, {
      window,
      document: { currentScript: { parentElement: root } },
      matchMedia: (query: string) => ({ matches: query.includes("dark") && systemDark }),
    });
    assert.equal(meta.content, expected, `${String(stored)} ${systemDark}`);
    assert.equal(meta.dataset.blastThemeColor, "#10171e");
  }
});

test("R3-02: a page without a theme-color meta, or without matchMedia, still boots", () => {
  const attributes = new Map<string, string>();
  const root = {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    ownerDocument: {},
  };
  const window = { innerWidth: 1440, localStorage: { getItem: () => null, setItem: () => undefined } };
  assert.doesNotThrow(() =>
    runInNewContext(SHELL_PREFS_BOOT_SCRIPT, { window, document: { currentScript: { parentElement: root } } }));
  assert.equal(attributes.get("data-theme-setting"), "system", "the preferences are still applied");
});

test("small balances are hidden by default, can be shown, and survive boot and attribute roundtrips", () => {
  const storage = memory();
  assert.equal(readShellPrefs(storage, 1440).hideSmallBalances, true);
  writeShellPref(storage, "hideSmallBalances", false);
  const prefs = readShellPrefs(storage, 1440);
  assert.equal(prefs.hideSmallBalances, false);
  assert.equal(boot(storage, 1440).get("data-small-balances"), "shown");
  const attributes = shellPrefAttributes(prefs);
  assert.equal(shellPrefsFromAttributes(name => attributes[name] ?? null).hideSmallBalances, false);
});
