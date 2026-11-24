export function reportViewTransitionError(error: unknown): void {
  if (error instanceof DOMException && error.name === "AbortError") return;
  console.error("Blast UI view transition failed", error);
}
