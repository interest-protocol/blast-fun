"use client";

import { useId, useSyncExternalStore } from "react";

import { splitDiagnostic } from "#web/lib/errors.ts";
import { StatusText } from "../primitives/StatusText";
import type { ActionState, SignerKind } from "../transaction/action-machine";
import { useLaunchpadSigners } from "../transaction/LaunchpadSignerProvider";
import { AMOUNT_REFUSALS, parseTradeAmount } from "./amount";
import { CurveTradeFill } from "./CurveTradeFill";
import { describeCompletedTrade, type CompletedTrade } from "./completed-trade";
import { inputDecimals, type CurveTradeInput, type TradeDirection } from "./curve-adapter";
import type { Curve } from "./curve-read";
import { useCurveTrade } from "./CurveTradeProvider";
import { unresolvedTrade } from "./curve-trade-provider-model";
import { tradeGuidance } from "./guidance";
import styles from "./trade.module.css";
import { indicativeEstimate } from "./curve-trade-rail-model";
import { atomsGrouped } from "@blast/core/web/format.ts";
import { bpsPercent } from "@blast/core/lib/bps.ts";

const SLIPPAGE_CHOICES: readonly bigint[] = [50n, 100n, 200n];
const SIGNER_LABELS: Readonly<Record<SignerKind, string>> = { wallet: "Sui wallet", privy: "Privy wallet" };
/** An observation older than this is called out as possibly stale. */
const STALE_AFTER_MS = 60_000;

const CLOCK_STEP_MS = 15_000;
const subscribeClock = (tick: () => void) => {
  const timer = setInterval(tick, CLOCK_STEP_MS);
  return () => clearInterval(timer);
};
/** The time, in steps, so an observation's age updates without re-rendering on every read. */
const clockSnapshot = () => Math.floor(Date.now() / CLOCK_STEP_MS) * CLOCK_STEP_MS;
const serverClock = () => 0;


/** The signed-out estimate from the last curve read, labeled with what was observed and when. */
function IndicativePreview({ curve, input, direction }: Readonly<{ curve: Curve; input: CurveTradeInput; direction: TradeDirection }>) {
  const now = useSyncExternalStore(subscribeClock, clockSnapshot, serverClock);
  const age = now === 0 ? 0 : now - curve.observation.observedAtMs;
  const estimate = indicativeEstimate(curve, input, direction);
  return (
    <div className={styles.preview} aria-live="polite">
      <p className={styles.observation} data-stale={age > STALE_AFTER_MS || undefined}>
        Estimate{age > STALE_AFTER_MS ? " · out of date" : ""}
      </p>
      {estimate ? (
        <dl className={styles.facts}>
          <div className={styles.factRow}>
            <dt>You receive about</dt>
            <dd>{estimate.receive}</dd>
          </div>
          <div className={styles.factRow}>
            <dt>Fewest you accept</dt>
            <dd>{estimate.minimum}</dd>
          </div>
          {estimate.detail ? <div className={styles.factRow}><dt>Fee</dt><dd>{estimate.detail}</dd></div> : null}
          {estimate.refund ? <div className={styles.factRow}><dt>Refund</dt><dd>{estimate.refund}</dd></div> : null}
          {estimate.burn ? <div className={styles.factRow}><dt>Burned</dt><dd>{estimate.burn}</dd></div> : null}
        </dl>
      ) : null}
    </div>
  );
}

function Outcome({ trade, curve, iconUrl, symbol }: Readonly<{
  trade: CompletedTrade | "unavailable" | undefined; curve: Curve | null; iconUrl?: string | null; symbol: string;
}>) {
  if (trade === undefined) {
    return (
      <p className={styles.note} role="status">
        Reading what the trade did on Sui…
      </p>
    );
  }
  if (trade === "unavailable") return <p className={styles.note}>The trade completed. Its details could not be read yet.</p>;
  return (
    <p className={styles.success}>
      <StatusText tone="up">{curve ? <><CurveTradeFill trade={trade} curve={curve} iconUrl={iconUrl} />.</> : describeCompletedTrade(trade, symbol, 9)}</StatusText>
    </p>
  );
}

function curveInputStatus(input: CurveTradeInput, direction: TradeDirection, ready: Curve | null, balances: ReturnType<typeof useCurveTrade>["balances"]) {
  const symbol = ready?.symbol ?? "the coin";
  const unit = direction === "buy" ? (ready?.quote.symbol ?? "Quote") : symbol;
  const decimals = ready ? inputDecimals(direction, ready) : null;
  const parsed = decimals === null ? null : parseTradeAmount(input.amount, decimals);
  const amountError = parsed && !parsed.ok && input.amount.trim() !== "" ? AMOUNT_REFUSALS[parsed.reason] : null;
  const balance = balances ? (direction === "buy" ? balances.quote : balances.meme) : null;
  // The last balance read is advisory: the review reads it again and refuses a short balance, so a stale read never disables Review.
  const short = parsed?.ok && balance !== null && parsed.atomic > balance;
  return { unit, decimals, parsed, amountError, balance, short };
}

function TradePanel({ direction, hidden }: Readonly<{ direction: TradeDirection; hidden: boolean }>) {
  const { controllers, deployment, curve, balances, refresh, completed, coinIconUrl } = useCurveTrade();
  const signers = useLaunchpadSigners();
  const controller = controllers[direction];
  const other = direction === "buy" ? "sell" : "buy";
  const state: ActionState<CurveTradeInput> = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const otherState = useSyncExternalStore(controllers[other].subscribe, controllers[other].getState, controllers[other].getState);
  // T-004's ambiguity rule: while either direction's answer is lost, nothing new is reviewed.
  const unresolved = unresolvedTrade({ [direction]: state, [other]: otherState } as Record<TradeDirection, ActionState<CurveTradeInput>>);
  const blockedByOther = unresolved !== null && unresolved.direction !== direction;
  const id = useId();
  const { input } = state;
  const ready = curve.status === "ok" ? curve.curve : null;
  const symbol = ready?.symbol ?? "the coin";
  const { unit, decimals, parsed, amountError, balance, short } = curveInputStatus(input, direction, ready, balances);
  const editable = ["editing", "blocked", "review", "rejected", "failed"].includes(state.phase);
  const live = ready?.launch.lifecycle === "Live";
  const canReview = editable && live && parsed?.ok === true && unresolved === null;
  const verb = direction === "buy" ? "Buy" : "Sell";
  const guidance = tradeGuidance(state, deployment);
  const edit = (patch: Partial<CurveTradeInput>) => controller.edit({ ...input, ...patch });

  return (
    <div className={styles.panel} hidden={hidden} role="tabpanel" id={`trade-panel-${direction}`} aria-labelledby={`trade-tab-${direction}`}>
      <CurveAmount id={id} direction={direction} unit={unit} amount={input.amount} editable={editable} amountError={amountError} short={short} balance={balance} decimals={decimals} edit={edit} />
      <fieldset className={styles.field}>
        <legend className={styles.label}>Slippage tolerance</legend>
        <div className={styles.choices}>
          {SLIPPAGE_CHOICES.map((bps) => (
            <label key={String(bps)} className={styles.choice}>
              <input
                type="radio"
                name={`${id}-slippage`}
                checked={input.slippageBps === bps}
                disabled={!editable}
                onChange={() => edit({ slippageBps: bps })}
              />
              <span>{bpsPercent(bps)}</span>
            </label>
          ))}
        </div>
        <p className={styles.note}>The trade fails, and nothing changes hands, if the price moves past this before it executes.</p>
      </fieldset>

      <CurveReadStatus curve={curve} input={input} direction={direction} live={live} refresh={refresh} />

      {blockedByOther ? (
        <p className={styles.notice} role="status" data-unresolved={unresolved.digest}>
          <StatusText tone="caution">
            A {unresolved.direction} is still unresolved on Sui. Reconcile it on the {unresolved.direction === "buy" ? "Buy" : "Sell"} tab before
            starting a new trade.
          </StatusText>
        </p>
      ) : null}

      <CurveActions state={state} controller={controller} kinds={signers.kinds} unresolved={unresolved} canReview={canReview} verb={verb} guidance={guidance} refresh={refresh} symbol={symbol} curve={ready} iconUrl={coinIconUrl} completed={completed} />
    </div>
  );
}

/**
 * Spot Buy and Sell on the launch's bonding curve. Signed out it shows an
 * indicative estimate from the last curve read; every review reads Sui
 * again, previews and builds with the SDK, and simulates before one signature.
 */
export function CurveTradeRail() {
  const { direction, setDirection } = useCurveTrade();
  return (
    <div className={styles.rail}>
      <div className={styles.tabs} role="tablist" aria-label="Trade direction">
        {(["buy", "sell"] as const).map((entry) => (
          <button
            key={entry}
            id={`trade-tab-${entry}`}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={direction === entry}
            aria-controls={`trade-panel-${entry}`}
            onClick={() => setDirection(entry)}
          >
            {entry === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <TradePanel direction="buy" hidden={direction !== "buy"} />
      <TradePanel direction="sell" hidden={direction !== "sell"} />
    </div>
  );
}

/** The trade rail where the app has no released deployment to trade on: honest, with nothing to sign. A reason's code, when it has one, shows on its own line. */
export function CurveTradeUnavailable({ reason }: Readonly<{ reason: string }>) {
  const { text, detail } = splitDiagnostic(reason);
  return (
    <div className={styles.rail}>
      <p className={styles.notice} data-trade-unavailable="">
        <StatusText tone="caution">{text}</StatusText>
        {detail !== null ? <span className="err-code">{detail}</span> : null}
      </p>
    </div>
  );
}

function CurveActions({ state, controller, kinds, unresolved, canReview, verb, guidance, refresh, symbol, curve, iconUrl, completed }: Readonly<{
  state: ActionState<CurveTradeInput>;
  controller: ReturnType<typeof useCurveTrade>["controllers"][TradeDirection];
  kinds: readonly SignerKind[];
  unresolved: ReturnType<typeof unresolvedTrade<CurveTradeInput>>;
  canReview: boolean;
  verb: string;
  guidance: ReturnType<typeof tradeGuidance>;
  refresh: () => void;
  symbol: string;
  curve: Curve | null;
  iconUrl?: string | null;
  completed: ReturnType<typeof useCurveTrade>["completed"];
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
          Reading the curve, your balances, and a simulation on Sui…
        </p>
      ) : null}
      {state.phase === "review" ? <CurveReview state={state} controller={controller} unresolved={unresolved} verb={verb} /> : null}
      {state.phase === "signing" ? (
        <p className={styles.note} role="status">
          Waiting for your wallet&rsquo;s signature…
        </p>
      ) : null}
      {state.phase === "reconciling" ? (
        <p className={styles.note} role="status">
          Confirming the trade on Sui…
        </p>
      ) : null}
      {state.phase === "succeeded" ? (
        <div className={styles.review}>
          <Outcome trade={completed[state.digest]} symbol={symbol} curve={curve} iconUrl={iconUrl} />
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
      {guidance ? <CurveGuidance state={state} controller={controller} unresolved={unresolved} guidance={guidance} refresh={refresh} /> : null}
    </div>
  );
}

function CurveReview({ state, controller, unresolved, verb }: Readonly<{
  state: Extract<ActionState<CurveTradeInput>, { phase: "review" }>;
  controller: ReturnType<typeof useCurveTrade>["controllers"][TradeDirection];
  unresolved: ReturnType<typeof unresolvedTrade<CurveTradeInput>>;
  verb: string;
}>) {
  return (
    <div className={styles.review}>
      {state.changes.length > 0 ? (
        <div role="alert" className={styles.notice}>
          <StatusText tone="caution">The curve changed since your last review. Confirm the new values.</StatusText>
          <ul className={styles.changes}>
            {state.changes.map((change) => (
              <li key={change.key}>
                {change.label}: {change.before ?? "none"} → {change.after ?? "none"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <h3 className={styles.reviewTitle}>Review: {verb.toLowerCase()} on the curve</h3>
      <dl className={styles.facts}>
        {state.review.facts.map((fact) => (
          <div key={fact.key} className={styles.factRow}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={unresolved !== null} onClick={() => controller.approve(state.review.id)}>
          {verb} and sign
        </button>
        <button type="button" className={styles.quiet} onClick={controller.cancel}>
          Cancel
        </button>
      </div>

    </div>
  );
}

function CurveGuidance({ state, controller, unresolved, guidance, refresh }: Readonly<{
  state: ActionState<CurveTradeInput>;
  controller: ReturnType<typeof useCurveTrade>["controllers"][TradeDirection];
  unresolved: ReturnType<typeof unresolvedTrade<CurveTradeInput>>;
  guidance: NonNullable<ReturnType<typeof tradeGuidance>>;
  refresh: () => void;
}>) {
  return (
    <div className={styles.notice} role="alert" data-guidance={guidance.action}>
      {state.phase === "blocked" ? <StatusText tone="caution">{state.block.message}</StatusText> : null}
      {state.phase === "failed" || state.phase === "ambiguous" ? <StatusText tone="caution">{state.message}</StatusText> : null}
      <p>{guidance.text}</p>
      <div className={styles.actions}>
        {state.phase === "ambiguous" ? (
          // Reconciles by the transaction digest only: it never signs or submits again.
          <button type="button" className={styles.secondary} onClick={controller.recheck}>
            Reconcile and continue
          </button>
        ) : guidance.action === "stop" || guidance.action === "route" ? (
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

function CurveReadStatus({ curve, input, direction, live, refresh }: Readonly<{ curve: ReturnType<typeof useCurveTrade>["curve"]; input: CurveTradeInput; direction: TradeDirection; live: boolean; refresh: () => void; }>) {
  return (
    curve.status === "reading" ? (
      <p className={styles.note} role="status">
        Reading the curve from Sui…
      </p>
    ) : curve.status === "unavailable" ? (
      <div className={styles.notice}>
        <StatusText tone="caution">{curve.message}</StatusText>
        <button type="button" className={styles.secondary} onClick={refresh}>
          Read the curve again
        </button>
      </div>
    ) : live ? (
      <IndicativePreview curve={curve.curve} input={input} direction={direction} />
    ) : (
      <div className={styles.notice}>
        <StatusText tone="caution">
          {curve.curve.launch.lifecycle === "Migrated"
            ? "This coin has graduated from its curve. Trade it on its venue pool."
            : curve.curve.launch.lifecycle === "OpeningRound"
              ? "The opening round is still running, so the curve does not trade yet."
              : "The curve reached its graduation target and is closed."}
        </StatusText>

      </div>
    )

  );
}

function CurveAmount({ id, direction, unit, amount, editable, amountError, short, balance, decimals, edit }: Readonly<{ id: string; direction: TradeDirection; unit: string; amount: string; editable: boolean; amountError: string | null; short: boolean | undefined; balance: bigint | null; decimals: number | null; edit: (patch: Partial<CurveTradeInput>) => void; }>) {
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
        disabled={!editable}
        aria-invalid={amountError ? true : undefined}
        aria-describedby={`${id}-amount-help`}
        onChange={(event) => edit({ amount: event.target.value })}
      />
      <p id={`${id}-amount-help`} className={amountError ? styles.error : styles.note}>
        {amountError ??
          (short
            ? `Your wallet held ${atomsGrouped(balance!, decimals!)} ${unit} available; insufficient balance.`
            : balance !== null
              ? `Balance: ${atomsGrouped(balance, decimals ?? 9)} ${unit}`
              : "Connect wallet to review.")}
      </p>
    </div>
  );
}
