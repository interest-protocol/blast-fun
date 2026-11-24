import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import type { WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import {
  formatVestingAmount,
  type CreateVesting,
} from "@blast/core/modules/vesting/model.ts";
import {
  amountAtoms,
  createSchedule,
  linearReleaseSummary,
  type CreationInput,
} from "./creation-model";
import { compactVestingAmount, localVestingDate } from "./creation-display";
import { VestingChart } from "./VestingChart";
import styles from "./Vesting.module.css";
import createStyles from "./Creation.module.css";

const ZERO_ATOMS = 0n;

function summaryOf(
  draft: CreationInput,
  coin: WalletCoinView | null,
  timezone: string,
) {
  let total: bigint | null = null;
  let schedule: CreateVesting["schedule"] | null = null;
  const amount = (value: bigint) =>
    `${formatVestingAmount(value, coin?.decimals ?? 0)} ${coin?.metadataAvailable === false ? "atoms" : (coin?.symbol ?? "")}`;
  try {
    if (coin) {
      total = amountAtoms(draft.total, coin.decimals);
      schedule = createSchedule(draft, total);
    }
  } catch {
    /* Missing or invalid fields never produce invented dates. */
  }
  const linear =
    schedule?.kind === "linear" && total
      ? linearReleaseSummary(schedule, total)
      : null;
  let first = "Complete schedule";
  let final = "Complete schedule";
  if (linear) {
    first = localVestingDate(linear.start, timezone);
    final = localVestingDate(linear.final, timezone);
  } else if (schedule?.kind === "checkpoints") {
    first = localVestingDate(schedule.checkpoints[0]!.timestamp_ms, timezone);
    final = localVestingDate(
      schedule.checkpoints.at(-1)!.timestamp_ms,
      timezone,
    );
  }
  return {
    customCount:
      schedule?.kind === "checkpoints" ? schedule.checkpoints.length : null,
    compact:
      total !== null && coin
        ? `${compactVestingAmount(total, coin.decimals)} ${coin.symbol}`
        : "Set an amount",
    totalLabel: total !== null ? amount(total) : "Set an amount",
    linear,
    schedule,
    total,
    first,
    final,
    amount,
  };
}
export function LiveSummary({
  draft,
  coin,
  timezone = "UTC",
}: Readonly<{
  draft: CreationInput;
  coin: WalletCoinView | null;
  timezone?: string;
}>) {
  const summary = summaryOf(draft, coin, timezone);
  const recipient =
    /^0x[\da-f]{64}$/i.test(draft.beneficiary.trim()) &&
    !/^0x0{64}$/i.test(draft.beneficiary.trim())
      ? `${draft.beneficiary.slice(0, 8)}…${draft.beneficiary.slice(-6)}`
      : "Add recipient";
  const single =
    summary.first === summary.final && summary.first !== "Complete schedule";
  const pattern =
    draft.kind === "linear"
      ? "Linear · continuous"
      : `${draft.releases.length} release date${draft.releases.length === 1 ? "" : "s"}`;
  return (
    <>
      <div className={createStyles.summaryHeading}>
        <h2>Your vesting</h2>
        <span>Sui Mainnet · All times {timezone}</span>
      </div>
      <div className={createStyles.summaryAmount}>
        <SummaryAmount compact={summary.compact} exact={summary.totalLabel} />
      </div>
      <p>Locked in full at creation</p>
      <dl className={styles.details}>
        <div>
          <dt>Recipient</dt>
          <dd>{recipient}</dd>
        </div>
        <div>
          <dt>Schedule</dt>
          <dd>{pattern}</dd>
        </div>
        <div>
          <dt>
            {draft.kind === "linear"
              ? "Vesting starts"
              : single
                ? "Release date"
                : "First release"}
          </dt>
          <dd>{summary.first}</dd>
        </div>
        {!single ? (
          <div>
            <dt>
              {draft.kind === "linear" ? "Fully vested" : "Final release"}
            </dt>
            <dd>{summary.final}</dd>
          </div>
        ) : null}
        <div>
          <dt>Cancellation</dt>
          <dd>{draft.cancelable ? "Allowed" : "Irrevocable"}</dd>
        </div>
        <CancellationSummary draft={draft} />
      </dl>
      <div className={createStyles.desktopPreview}>
        {summary.schedule && summary.total !== null ? (
          <VestingChart
            schedule={{ terms: summary.schedule, total: String(summary.total) }}
          />
        ) : null}
        <ReleaseExplanation
          summary={summary}
          cliffDays={draft.cliffDays}
          timezone={timezone}
        />
      </div>
    </>
  );
}
function SummaryAmount({ compact, exact }: Readonly<{ compact: string; exact: string }>) {
  if (compact === exact) return compact;
  return <InspectValue label="vesting amount" value={exact}>{compact}</InspectValue>;
}

function ReleaseExplanation({
  summary,
  cliffDays,
  timezone,
}: Readonly<{
  summary: ReturnType<typeof summaryOf>;
  cliffDays: string;
  timezone: string;
}>) {
  const { linear, amount } = summary;
  if (!linear) return null;
  return (
    <div className={createStyles.scheduleNote}>

      {BigInt(cliffDays.trim() || "0") > ZERO_ATOMS ? (
        <p>
          Cliff ends {localVestingDate(linear.cliffEnd, timezone)}
        </p>
      ) : null}
      <p>
        First claimable: {amount(linear.firstAmount)} on{" "}
        {localVestingDate(linear.first, timezone)}.
      </p>
    </div>
  );
}

function CancellationSummary({ draft }: Readonly<{ draft: CreationInput }>) {
  if (!draft.cancelable) return null;
  return (
    <>
      <div>
        <dt>Refund wallet</dt>
        <dd>
          {draft.refund
            ? `${draft.refund.slice(0, 8)}…${draft.refund.slice(-6)}`
            : "Add refund wallet"}
        </dd>
      </div>
      <div>
        <dt>Who can cancel</dt>
        <dd>
          {draft.capRecipient
            ? `${draft.capRecipient.slice(0, 8)}…${draft.capRecipient.slice(-6)}`
            : "Choose authority"}
        </dd>
      </div>
    </>
  );
}
