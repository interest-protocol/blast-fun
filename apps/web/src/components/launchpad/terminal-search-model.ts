import { createContext } from "react";

/** Closes the search surface; a result calls it before its route changes. */
export const CloseSearchContext = createContext<() => void>(() => {});
