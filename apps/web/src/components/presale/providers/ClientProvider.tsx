import type { PresaleSlotProps } from "./slot";

/** Slot 2: the presale client (data transports). Pass-through until its ticket replaces this file. */
export function ClientProvider({ children }: PresaleSlotProps) {
  return <>{children}</>;
}
