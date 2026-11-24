"use client";

import { THEME_SETTINGS, themeLabel } from "./prefs";
import { SegThumb } from "./SegThumb";
import { applyTheme, useShellPrefs } from "./use-shell-prefs";

/**
 * Settings → Appearance → Theme (FEATURE-MAP §7, tokens.md §1): a segmented
 * `System · Light · Dark` control. Choosing one is remembered on this device
 * and reveals the new theme from the pressed button.
 */
export function ThemeControl() {
  const { theme } = useShellPrefs();
  return (
    <div aria-label="Theme" className="seg" role="group">
      {THEME_SETTINGS.map((setting) => (
        <button
          aria-pressed={theme === setting}
          key={setting}
          onClick={(event) => {
            if (setting !== theme) applyTheme(setting, event.currentTarget);
          }}
          type="button"
        >
          {themeLabel(setting)}
        </button>
      ))}
      <SegThumb on={theme} />
    </div>
  );
}
