import type { ReactNode } from "react";

import type { CoinRounds, RowContext } from "./RewardsParts";
import type { RewardCoinView } from "./rewards-model";

/** The live read supplying an open coin's rounds. */
export type RoundsSource = (props: Readonly<{ coin: RewardCoinView; open: boolean; ctx: RowContext; children: (rounds: CoinRounds) => ReactNode }>) => ReactNode;
