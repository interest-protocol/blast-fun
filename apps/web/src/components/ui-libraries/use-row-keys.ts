import { useState } from "react";

/**
 * Stable keys for a list of recipient rows, which carry no id of their own: one
 * per row, kept through a removal (`drop`, by index), a new one for each row
 * added at the end, so removing a row never hands its neighbour's inputs to it.
 */
export function useRowKeys(count: number): Readonly<{ keys: readonly number[]; drop: (index: number) => void }> {
  const [state, setState] = useState(() => ({ keys: Array.from({ length: count }, (_, at) => at), next: count }));
  let current = state;
  if (state.keys.length !== count) {
    const grow = count - state.keys.length;
    current = grow > 0
      ? { keys: [...state.keys, ...Array.from({ length: grow }, (_, at) => state.next + at)], next: state.next + grow }
      : { keys: state.keys.slice(0, count), next: state.next };
    setState(current);
  }
  return { keys: current.keys, drop: (index) => setState((was) => ({ keys: was.keys.filter((_, at) => at !== index), next: was.next })) };
}
