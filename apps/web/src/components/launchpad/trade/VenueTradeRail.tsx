"use client";

import { useId, useSyncExternalStore } from "react";

import { TradeFill } from "#web/components/blast-ui/CoinAmount.tsx";

import { StatusText } from "../primitives/StatusText";
import type { ActionState, SignerKind } from "../transaction/action-machine";
import { useLaunchpadSigners } from "../transaction/LaunchpadSignerProvider";
import { AMOUNT_REFUSALS, parseTradeAmount } from "./amount";
import type { TradeDirection } from "./curve-adapter";

import { unresolvedTrade } from "./curve-trade-provider-model";
import styles from "./trade.module.css";
import type { VenueTradeInput } from "./venue-adapter";
import { describeVenueUnavailable, type RecordedVenue, type VenueTrade } from "./venue-route";
import { reviewExpired, venueGuidance, venueProblem } from "./venue-session";
import { useVenueTrade } from "./VenueTradeProvider";
import { poolPriceText } from "./venue-trade-rail-model";
import { VENUE_PRODUCTS } from "@blast/core/modules/launchpad-contract/venues.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";
import { bpsPercent } from "@blast/core/lib/bps.ts";

const SLIPPAGE_CHOICES: readonly bigint[] = [50n, 100n, 200n];
const SIGNER_LABELS: Readonly<Record<SignerKind, string>> = { wallet: "Sui wallet", privy: "Privy wallet" };

const subscribeSecond = (tick: () => void) => {
  const timer = setInterval(tick, 1_000);
  return () => clearInterval(timer);
};
const secondSnapshot = () => Math.floor(Date.now() / 1_000) * 1_000;
const serverClock = () => 0;

const time = (ms: number) => new Date(ms).toISOString().slice(11, 19);

function Outcome({ trade, recorded }: Readonly<{ trade: VenueTrade | "unavailable" | undefined; recorded: RecordedVenue | null }>) {
  if (trade === undefined) {
    return (
      <p className={styles.note} role="status">
        Reading what the swap did on Sui…
      </p>
    );
  }
  if (trade === "unavailable" || !recorded) return <p className={styles.note}>The swap completed. Its details could not be read yet.</p>;
  return (
    <p className={styles.success}>
      <StatusText tone="up">
        <TradeFill verb={trade.side === "buy" ? "Bought" : "Sold"}
          first={{ amount: atomsGrouped(trade.memeAmount, recorded.decimals), symbol: recorded.symbol, coinType: recorded.launch.memeType }}
          second={{ ...recorded.quote, amount: atomsGrouped(trade.quoteAmount, recorded.quote.decimals) }}
        /> on {VENUE_PRODUCTS[recorded.venue]}.
      </StatusText>
    </p>
  );
}

function venueInputStatus(input: VenueTradeInput, direction: TradeDirection, recorded: RecordedVenue | null, balances: ReturnType<typeof useVenueTrade>["balances"]) {
  const symbol = recorded?.symbol ?? "the coin";
  const unit = direction === "buy" ? (recorded?.quote.symbol ?? "Quote") : symbol;
  const decimals = recorded ? (direction === "buy" ? recorded.quote.decimals : recorded.decimals) : null;
  const parsed = decimals === null ? null : parseTradeAmount(input.amount, decimals);
  const amountError = parsed && !parsed.ok && input.amount.trim() !== "" ? AMOUNT_REFUSALS[parsed.reason] : null;
  const balance = balances ? (direction === "buy" ? balances.quote : balances.meme) : null;
  return { unit, decimals, parsed, amountError, balance };
}

function VenuePanel({ direction, hidden }: Readonly<{ direction: TradeDirection; hidden: boolean }>) {
  const { controllers, deployment, route, availability, balances, refresh, completed, now: clock } = useVenueTrade();
  const signers = useLaunchpadSigners();
  const controller = controllers[direction];
  const other = direction === "buy" ? "sell" : "buy";
  const state: ActionState<VenueTradeInput> = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const otherState = useSyncExternalStore(controllers[other].subscribe, controllers[other].getState, controllers[other].getState);
  // Re-renders every second so an open review shows its quote expiring; the session's clock decides it.
  const tick = useSyncExternalStore(subscribeSecond, secondSnapshot, serverClock);
  const unresolved = unresolvedTrade<VenueTradeInput>({ [direction]: state, [other]: otherState } as Record<TradeDirection, ActionState<VenueTradeInput>>);
  const blockedByOther = unresolved !== null && unresolved.direction !== direction;
  const id = useId();
  const { input } = state;
  const recorded = route.status === "ok" ? route.recorded : null;
  const { unit, decimals, parsed, amountError, balance } = venueInputStatus(input, direction, recorded, balances);
  const venueOpen = recorded !== null && availability !== null && "available" in availability && availability.available;
  const editable = ["editing", "blocked", "review", "rejected", "failed"].includes(state.phase);
  const canReview = editable && venueOpen && parsed?.ok === true && unresolved === null;
  const verb = direction === "buy" ? "Buy" : "Sell";
  const guidance = venueGuidance(state, deployment);
  const problem = venueProblem(state, deployment);
  const expired = tick !== 0 && reviewExpired(state, clock());
  const edit = (patch: Partial<VenueTradeInput>) => controller.edit({ ...input, ...patch });

  return (
    <div className={styles.panel} hidden={hidden} role="tabpanel" id={`venue-panel-${direction}`} aria-labelledby={`venue-tab-${direction}`}>
      <VenueAmount id={id} direction={direction} unit={unit} amount={input.amount} editable={editable} recorded={recorded} amountError={amountError} balance={balance} decimals={decimals} edit={edit} />
      <fieldset className={styles.field} disabled={!editable || !recorded}>
        <legend className={styles.label}>Slippage tolerance</legend>
        <div className={styles.choices}>
          {SLIPPAGE_CHOICES.map((bps) => (
            <label key={String(bps)} className={styles.choice}>
              <input type="radio" name={`${id}-slippage`} checked={input.slippageBps === bps} onChange={() => edit({ slippageBps: bps })} />
              <span>{bpsPercent(bps)}</span>
            </label>
          ))}
        </div>
        <p className={styles.note}>The swap fails, and nothing changes hands, if the pool moves past this before it executes.</p>
      </fieldset>

      <VenueReadStatus route={route} availability={availability} refresh={refresh} />

      {blockedByOther ? (
        <p className={styles.notice} role="status" data-unresolved={unresolved.digest}>
          <StatusText tone="caution">
            A {unresolved.direction} is still unresolved on Sui. Reconcile it on the {unresolved.direction === "buy" ? "Buy" : "Sell"} tab before
            starting a new trade.
          </StatusText>
        </p>
      ) : null}

      <VenueActions state={state} controller={controller} kinds={signers.kinds} unresolved={unresolved} canReview={canReview} verb={verb} guidance={guidance} refresh={refresh} problem={problem} recorded={recorded} expired={expired} completed={completed} />
    </div>
  );
}

/**
 * Spot Buy and Sell on the venue pool the launch recorded at migration. The
 * venue is never chosen here; every review reads the recorded route, gets an
 * exact quote, builds with the SDK, and simulates before one signature.
 */
export function VenueTradeRail() {
  const { direction, setDirection } = useVenueTrade();
  return (
    <div className={styles.rail} data-venue-rail="">
      <div className={styles.tabs} role="tablist" aria-label="Trade direction">
        {(["buy", "sell"] as const).map((entry) => (
          <button
            key={entry}
            id={`venue-tab-${entry}`}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={direction === entry}
            aria-controls={`venue-panel-${entry}`}
            onClick={() => setDirection(entry)}
          >
            {entry === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <VenuePanel direction="buy" hidden={direction !== "buy"} />
      <VenuePanel direction="sell" hidden={direction !== "sell"} />
    </div>
  );
}

/** The venue rail where nothing can be signed: why, with the venue named; the page's history stays. */
export function VenueTradeUnavailable({ reason }: Readonly<{ reason: string }>) {
  return (
    <div className={styles.rail}>
      <p className={styles.notice} data-trade-unavailable="">
        <StatusText tone="caution">{reason}</StatusText>
      </p>
    </div>
  );
}

function VenueActions({ state, controller, kinds, unresolved, canReview, verb, guidance, refresh, problem, recorded, expired, completed }: Readonly<{
  state: ActionState<VenueTradeInput>;
  controller: ReturnType<typeof useVenueTrade>["controllers"][TradeDirection];
  kinds: readonly SignerKind[];
  unresolved: ReturnType<typeof unresolvedTrade<VenueTradeInput>>;
  canReview: boolean;
  verb: string;
  guidance: ReturnType<typeof venueGuidance>;
  refresh: () => void;
  problem: string | null;
  recorded: RecordedVenue | null;
  expired: boolean;
  completed: ReturnType<typeof useVenueTrade>["completed"];
}>) {
  return (
    <div className={styles.action} aria-live="polite">
      {state.phase === "editing" ? (
        <>
          {state.notice ? (
            <p className={styles.notice}>
              <StatusText tone="caution">{state.notice.message}</StatusText>
            </p>
          ) : null}
          <button type="button" className={styles.primary} disabled={!canReview} onClick={() => controller.submit()}>
            Review {verb.toLowerCase()}
          </button>
        </>
      ) : null}
      {state.phase === "choosing-signer" ? (
        <div className={styles.notice}>

          <div className={styles.actions}>
            {kinds.map((kind) => (
              <button key={kind} type="button" className={styles.secondary} disabled={unresolved !== null} onClick={() => controller.chooseSigner(kind)}>
                {SIGNER_LABELS[kind]}
              </button>
            ))}
            <button type="button" className={styles.quiet} onClick={controller.cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {state.phase === "connecting" || state.phase === "preflighting" ? (
        <p className={styles.note} role="status">
          Reading the recorded route, your balances, a fresh quote, and a simulation on Sui…
        </p>
      ) : null}
      {state.phase === "review" ? <VenueReview state={state} controller={controller} unresolved={unresolved} verb={verb} recorded={recorded} expired={expired} /> : null}
      {state.phase === "signing" ? (
        <p className={styles.note} role="status">
          Waiting for your wallet&rsquo;s signature…
        </p>
      ) : null}
      {state.phase === "reconciling" ? (
        <p className={styles.note} role="status">
          Confirming the swap on Sui…
        </p>
      ) : null}
      {state.phase === "succeeded" ? (
        <div className={styles.review}>
          <Outcome trade={completed[state.digest]} recorded={recorded} />
          {state.explorerUrl ? (
            <a className={styles.link} href={state.explorerUrl} target="_blank" rel="noreferrer">
              View the transaction
            </a>
          ) : null}
          <button type="button" className={styles.secondary} onClick={controller.acknowledge}>
            Trade again
          </button>
        </div>
      ) : null}
      {guidance ? <VenueGuidance state={state} controller={controller} unresolved={unresolved} guidance={guidance} refresh={refresh} problem={problem} /> : null}
    </div>
  );
}

function VenueReview({ state, controller, unresolved, verb, recorded, expired }: Readonly<{
  state: Extract<ActionState<VenueTradeInput>, { phase: "review" }>;
  controller: ReturnType<typeof useVenueTrade>["controllers"][TradeDirection];
  unresolved: ReturnType<typeof unresolvedTrade<VenueTradeInput>>;
  verb: string;
  recorded: RecordedVenue | null;
  expired: boolean;
}>) {
  return (
    <div className={styles.review}>
      {state.changes.length > 0 ? (
        <div role="alert" className={styles.notice}>
          <StatusText tone="caution">The quote changed since your last review. Confirm the new values.</StatusText>
          <ul className={styles.changes}>
            {state.changes.map((change) => (
              <li key={change.key}>
                {change.label}: {change.before ?? "none"} → {change.after ?? "none"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <h3 className={styles.reviewTitle}>
        Review: {verb.toLowerCase()} on {recorded ? VENUE_PRODUCTS[recorded.venue] : "the venue pool"}
      </h3>
      <dl className={styles.facts}>
        {state.review.facts.map((fact) => (
          <div key={fact.key} className={styles.factRow}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {state.review.expiresAtMs ? (
        <p className={styles.note} data-quote-expired={expired || undefined}>
          {expired
            ? `This quote expired at ${time(state.review.expiresAtMs)} UTC. Get a fresh quote and confirm it before signing.`
            : `Quote valid until ${time(state.review.expiresAtMs)} UTC.`}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={unresolved !== null} onClick={() => controller.approve(state.review.id)}>
          {expired ? "Get a fresh quote" : `${verb} and sign`}
        </button>
        <button type="button" className={styles.quiet} onClick={controller.cancel}>
          Cancel
        </button>
      </div>

    </div>
  );
}

function VenueGuidance({ state, controller, unresolved, guidance, refresh, problem }: Readonly<{
  state: ActionState<VenueTradeInput>;
  controller: ReturnType<typeof useVenueTrade>["controllers"][TradeDirection];
  unresolved: ReturnType<typeof unresolvedTrade<VenueTradeInput>>;
  guidance: NonNullable<ReturnType<typeof venueGuidance>>;
  refresh: () => void;
  problem: string | null;
}>) {
  return (
    <div className={styles.notice} role="alert" data-guidance={guidance.action}>
      {problem ? <StatusText tone="caution">{problem}</StatusText> : null}
      {state.phase === "blocked" && state.block.details.length > 0 ? <p className={styles.note}>{state.block.details.join(" ")}</p> : null}
      <p>{guidance.text}</p>
      <div className={styles.actions}>
        {state.phase === "ambiguous" ? (
          // Reconciles by the transaction digest only: it never signs or submits again.
          <button type="button" className={styles.secondary} onClick={controller.recheck}>
            Reconcile and continue
          </button>
        ) : guidance.action === "stop" ? (
          <button type="button" className={styles.secondary} onClick={() => (refresh(), controller.cancel())}>
            Back
          </button>
        ) : (
          <>
            <button
              type="button"
              className={styles.secondary}
              disabled={unresolved !== null}
              onClick={() => {
                refresh();
                controller.submit();
              }}
            >
              Review again
            </button>
            <button type="button" className={styles.quiet} onClick={state.phase === "blocked" ? controller.cancel : controller.acknowledge}>
              Change the amount
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function VenueReadStatus({ route, availability, refresh }: Readonly<{ route: ReturnType<typeof useVenueTrade>["route"]; availability: ReturnType<typeof useVenueTrade>["availability"]; refresh: () => void; }>) {
  if (route.status === "reading") return (
    <p className={styles.note} role="status">
      Reading the recorded venue route from Sui…
    </p>
  );
  if (route.status === "unavailable") return (

    <div className={styles.notice}>
      <StatusText tone="caution">{route.message}</StatusText>
      <button type="button" className={styles.secondary} onClick={refresh}>
        Read the route again
      </button>
    </div>
  );
  if (route.status === "refused") return (

    <p className={styles.notice} data-venue-refused={route.code}>
      <StatusText tone="caution">{route.message}</StatusText>
    </p>
  );
  return (

    <div className={styles.preview}>
      <p className={styles.observation}>
        Pool price {poolPriceText(route.recorded)}
      </p>
      {availability === null || ("status" in availability && availability.status === "reading") ? (
        <p className={styles.note} role="status">
          Checking that {VENUE_PRODUCTS[route.recorded.venue]} is available for this deployment…
        </p>
      ) : "available" in availability && !availability.available ? (
        <p className={styles.notice} data-venue-unavailable="">
          <StatusText tone="caution">{describeVenueUnavailable(route.recorded.venue, availability)}</StatusText>
        </p>
      ) : null}
    </div>
  );
}

function VenueAmount({ id, direction, unit, amount, editable, recorded, amountError, balance, decimals, edit }: Readonly<{ id: string; direction: TradeDirection; unit: string; amount: string; editable: boolean; recorded: RecordedVenue | null; amountError: string | null; balance: bigint | null; decimals: number | null; edit: (patch: Partial<VenueTradeInput>) => void; }>) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={`${id}-amount`}>
        {direction === "buy" ? "You pay" : "You sell"} <span className={styles.unit}>({unit})</span>
      </label>
      <input
        id={`${id}-amount`}
        className={styles.input}
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        value={amount}
        disabled={!editable || !recorded}
        aria-invalid={amountError ? true : undefined}
        aria-describedby={`${id}-amount-help`}
        onChange={(event) => edit({ amount: event.target.value })}
      />
      <p id={`${id}-amount-help`} className={amountError ? styles.error : styles.note}>
        {amountError ??
          (balance !== null && decimals !== null
            ? `Balance: ${atomsGrouped(balance, decimals)} ${unit}`
            : "Connect wallet to review.")}
      </p>
    </div>
  );
}
