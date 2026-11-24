"use client";

import clsx from "clsx";

import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { Sparkline } from "#web/components/charts/Sparkline.tsx";

import { sparkOf, usePrice } from "../prices/price-client";
import styles from "./PostCard.module.css";
import type { PostCall } from "./post-model";
import { PresaleMark } from "./PostMedia";

/**
 * A call's result card (FEATURE-MAP §3.4, OA-9): the presale's mark and name,
 * "Trading on Cetus · now $0.0021", the multiple ("4.2×", green from 1×, red
 * below) and the coin's price since it started trading in the 89×28
 * sparkline (R3-20, `GET /api/social/prices?window=launch`), coloured by the
 * multiple as the gate's card is. Without a price history the place stays
 * empty; the layout does not change when the line arrives.
 */
export function CallCard({ call, iconOnlyVenue = false }: Readonly<{ call: PostCall; iconOnlyVenue?: boolean }>) {
  const price = usePrice({ presaleId: call.presale.presale_id, window: "launch" });
  return (
    <div className={styles.callc}>
      <PresaleMark coinType={call.presale.coin_type} presaleId={call.presale.presale_id} size={34} src={call.presale.icon_url} />
      <span className={styles.callT}>
        <b>{call.presale.name}{call.presale.verified_team ? <>{"\u00a0"}<CoinVerifiedMark /></> : null}</b>
        <span>{iconOnlyVenue ? null : "Trading on "}<DexIdentity iconOnly={iconOnlyVenue} venue={call.presale.venue} />{call.price ? ` · now ${call.price}` : null}</span>
      </span>
      <span className={styles.callR}>
        {call.result ? (
          <span className={clsx(styles.pnl, call.up ? styles.up : styles.down)}>{call.result}</span>
        ) : null}
        <Sparkline className={styles.spark} height={28} points={sparkOf(price)} slot="call-sparkline" up={call.up} width={89} />
      </span>
    </div>
  );
}
