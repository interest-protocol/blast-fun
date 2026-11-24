import { toast } from "sonner";

/** Closes a previous result before its replacement is shown. */
export function dismissToast(id: string): void {
  toast.dismiss(id);
}

/** Check before updating a notification so a late result cannot reopen it. */
export function hasActiveToast(id: string): boolean {
  return toast.getToasts().some((entry) => entry.id === id);
}
