import type { PresaleSlotProps } from "./slot";

/** Slot 5: the presale theme root. Pass-through until its ticket replaces this file. */
export function ThemeProvider({ children }: PresaleSlotProps) {
  return <>{children}</>;
}
