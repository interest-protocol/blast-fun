import { createContext } from "react";

/** Blast callsigns explicitly selected for the KOL list. Verification is independent. */
export const LISTED_KOL_CALLSIGNS: readonly string[] = [];

/** Hosts may supply a curated list; fixture entries never change production membership. */
export const ListedKolsContext = createContext<readonly string[]>(LISTED_KOL_CALLSIGNS);
