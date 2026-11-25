/** The Happening read's discovery weights (`happening/read.ts` scores in SQL with these). */
export const DISCOVERY_WEIGHTS = { participants: 35, activity: 30, freshness: 25, context: 10 } as const;
export const DISCOVERY_PARTICIPANT_CAP = 8;
export const DISCOVERY_VOLUME_CAP = 1_000;
export const DISCOVERY_PRESALE_GOAL_FRACTION = 0.1;
