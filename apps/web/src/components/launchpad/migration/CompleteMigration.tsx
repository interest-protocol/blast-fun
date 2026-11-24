"use client";

import { TransactionLink } from "#web/components/blast-ui/TransactionLink.tsx";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { StatusText } from "../primitives/StatusText";
import type { SignerKind } from "../transaction/action-machine";
import { useLaunchpadSigners } from "../transaction/LaunchpadSignerProvider";
import type { LaunchpadChain } from "../transaction/preflight";
import styles from "./Migration.module.css";
import { createMigrationFlow, type MigrationCompletion, type MigrationDiagnostic, type MigrationFlow, type MigrationFlowState } from "./migration-flow";
import { useCaptureSignerToast } from "../transaction/use-capture-signer-toast";

type Controls = Pick<
  MigrationFlow,
  "submit" | "chooseSigner" | "cancel" | "approve" | "recheck" | "acknowledge" | "checkAgain"
>;

const SIGNER_LABEL: Readonly<Record<SignerKind, string>> = { privy: "Privy wallet", wallet: "Sui wallet" };

function Intro({ venue }: Readonly<{ venue: string }>) {
  return (
    <>
      <div className={styles.intro}><span>Migration venue</span><DexIdentity venue={venue} size={20} /></div>
    </>
  );
}

function Caution({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className={styles.message}>
      <StatusText tone="caution">{children}</StatusText>
    </p>
  );
}

function TransactionNote({ digest, explorerUrl }: Readonly<{ digest: string | null; explorerUrl: string | null }>) {
  if (!digest) return null;
  return (
    <p className={styles.note}>
      Transaction <code className={styles.digest}>{digest}</code>
      {explorerUrl ? (
        <>
          {" "}
          <a className={styles.link} href={explorerUrl} rel="noreferrer" target="_blank">
            View on the explorer
          </a>
        </>
      ) : null}
    </p>
  );
}

/** What fresh reconciliation says about the launch after a block or failure. */
function SettlementNote({ state, controls }: Readonly<{ state: MigrationFlowState; controls: Controls }>) {
  const { settlement } = state;
  switch (settlement.status) {
    case "checking":
      return (
        <p className={styles.note} role="status">
          Reading the launch from Sui to see whether it has migrated…
        </p>
      );
    case "still-ready":
      return <p className={styles.message}>{settlement.message}</p>;
    case "unverified":
      return (
        <>
          <Caution>{settlement.message}</Caution>
          <div className={styles.actions}>
            <Button onClick={controls.checkAgain}>Check again</Button>
          </div>
        </>
      );
    default:
      return null;
  }
}

function MigrationBlocked({ state, action, controls }: Readonly<{ state: MigrationFlowState; action: Extract<MigrationFlowState["action"], { phase: "blocked" }>; controls: Controls }>) {
  return (
    <>
      <Caution>{action.block.message}</Caution>
      {action.block.details.length > 0 ? (
        <ul className={styles.details}>
          {action.block.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      <SettlementNote state={state} controls={controls} />
      {state.settlement.status === "checking" ? null : (
        <div className={styles.actions}>
          <Button variant="primary" className={styles.primary} size="lg" onClick={controls.submit}>
            Review again
          </Button>
          <Button onClick={controls.cancel}>Cancel</Button>
        </div>
      )}
    </>
  );
}

function MigrationFailed({ state, action, controls }: Readonly<{ state: MigrationFlowState; action: Extract<MigrationFlowState["action"], { phase: "failed" }>; controls: Controls }>) {
  return (
    <>
      <Caution>{action.message}</Caution>
      <TransactionNote digest={action.digest} explorerUrl={action.explorerUrl} />
      <SettlementNote state={state} controls={controls} />
      {state.settlement.status === "checking" ? null : (
        <div className={styles.actions}>
          <Button variant="primary" className={styles.primary} size="lg" onClick={controls.submit}>
            Review again
          </Button>
        </div>
      )}
    </>
  );
}

function MigrationAmbiguous({ action, controls }: Readonly<{ action: Extract<MigrationFlowState["action"], { phase: "ambiguous" }>; controls: Controls }>) {
  return (
    <>
      <Caution>{action.message}</Caution>
      {action.reason === "evidence-missing" ? (
        <p className={styles.note}>
          Transaction <code className={styles.digest}>{action.digest}</code> completed without migrating the launch.
        </p>
      ) : (
        <p className={styles.note}>
          Transaction <code className={styles.digest}>{action.digest}</code> will not be signed or sent again
          automatically. No other migration can start here until Sui settles it.
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="primary" className={styles.primary} size="lg" onClick={controls.recheck}>
          Check again
        </Button>
        {/* Only a settled transaction may be left: an unresolved one could still migrate the launch. */}
        {action.reason === "evidence-missing" ? <Button onClick={controls.acknowledge}>Back</Button> : null}
      </div>
    </>
  );
}

function Phase({ state, signerKinds, controls }: Readonly<{ state: MigrationFlowState; signerKinds: readonly SignerKind[]; controls: Controls }>) {
  const { action } = state;
  switch (action.phase) {
    case "editing":
      return (
        <>
          {action.notice ? <Caution>{action.notice.message}</Caution> : null}
          <div className={styles.actions}>
            <Button variant="primary" className={styles.primary} size="lg" onClick={controls.submit}>
              Complete migration
            </Button>
          </div>
        </>
      );
    case "choosing-signer":
      return (
        <>

          <div className={styles.actions}>
            {signerKinds.map((kind) => (
              <Button key={kind} onClick={() => controls.chooseSigner(kind)}>
                {SIGNER_LABEL[kind]}
              </Button>
            ))}
            <Button onClick={controls.cancel}>Cancel</Button>
          </div>
        </>
      );
    case "connecting":
      return <p className={styles.note} role="status">Connecting your {SIGNER_LABEL[action.signerKind]}…</p>;
    case "preflighting":
      return (
        <p className={styles.note} role="status">
          Checking the deployment, your wallet&apos;s network, the launch, its route and venue objects, and simulating
          the migration on Sui…
        </p>
      );
    case "blocked":
      return <MigrationBlocked state={state} action={action} controls={controls} />;
    case "review":
      return <ApprovalReview action={action} controls={controls} />;
    case "signing":
      return <p className={styles.note} role="status">Waiting for your signature in the wallet…</p>;
    case "rejected":
      return (
        <>
          <p className={styles.message}>{action.message}</p>
          <div className={styles.actions}>
            <Button variant="primary" className={styles.primary} size="lg" onClick={controls.submit}>
              Review again
            </Button>
          </div>
        </>
      );
    case "reconciling":
      return (
        <p className={styles.note} role="status">
          Confirming transaction <code className={styles.digest}>{action.digest}</code> on Sui. It is not complete
          until Sui records the launch&apos;s Migrated event.
        </p>
      );
    case "succeeded":
      // Completion shows only from the settlement; a succeeded action without one is still confirming.
      return <p className={styles.note} role="status">Confirming the migration on Sui…</p>;
    case "failed":
      return <MigrationFailed state={state} action={action} controls={controls} />;
    case "ambiguous":
      return <MigrationAmbiguous action={action} controls={controls} />;
  }
}

function Completed({
  completion,
  lostRace,
}: Readonly<{ completion: MigrationCompletion; venue: string; lostRace: boolean }>) {
  if (completion.by === "you") {
    return (
      <>
        <div className={styles.confirmation}>
          <p className={styles.message} role="status">
            <StatusText tone="up">Migration complete. Sui recorded the launch&apos;s Migrated event.</StatusText>
          </p>
          {completion.digest && completion.explorerUrl ? <TransactionLink href={completion.explorerUrl} /> : null}
        </div>
        <TransactionNote digest={completion.digest} explorerUrl={null} />
      </>
    );
  }
  return (
    <>
      <p className={styles.message} role="status">
        <StatusText tone="flat">Already migrated.</StatusText>
      </p>
      <p className={styles.note}>{lostRace ? "Your transaction failed. Only the network fee was spent." : "Nothing was submitted from your wallet."}</p>
    </>
  );
}

/** The migration action's view of one flow state. Presentational; `controls` drive the flow. */
export function MigrationPanel({
  state,
  venue,
  signerKinds,
  controls,
}: Readonly<{ state: MigrationFlowState; venue: string; signerKinds: readonly SignerKind[]; controls: Controls }>) {
  const { settlement } = state;
  return (
    <section className={styles.migration} aria-label="Complete migration" data-phase={state.action.phase}>
      <Intro venue={venue} />
      <div aria-live="polite" className={styles.migration}>
        {settlement.status === "completed" ? (
          <Completed completion={settlement} venue={venue} lostRace={state.action.phase === "failed" && state.action.stage === "execution"} />
        ) : (
          <Phase state={state} signerKinds={signerKinds} controls={controls} />
        )}
      </div>
    </section>
  );
}

/** The action while this app cannot sign at all: visible, disabled, with the reason. */
export function MigrationUnavailable({ venue, reason }: Readonly<{ venue: string; reason: string }>) {
  return (
    <section className={styles.migration} aria-label="Complete migration">
      <Intro venue={venue} />
      <p className={styles.message}>{reason}</p>
      <div className={styles.actions}>
        <Button variant="primary" className={styles.primary} size="lg" disabled>
          Complete migration
        </Button>
      </div>
    </section>
  );
}

/**
 * The public Complete migration action for one launch: any connected wallet,
 * a fresh preflight, one signature, and completion only from Sui's Migrated
 * evidence. `chain` is fixed for the component's lifetime.
 */
export function CompleteMigration({
  launchId,
  venue,
  chain,
  report,
  onCompleted,
}: Readonly<{
  launchId: string;
  venue: string;
  chain: LaunchpadChain;
  report?: (diagnostic: MigrationDiagnostic) => void;
  onCompleted?: (completion: MigrationCompletion) => void;
}>) {
  const signers = useLaunchpadSigners();
  const captureToast = useCaptureSignerToast(signers);
  const [flow] = useState(() => createMigrationFlow({
    chain,
    signers,
    launchId,
    venue,
    report,
    captureConfirmation(signer) {
      const show = captureToast(signer);
      return (completion) => show("Migration complete", {
        href: completion.explorerUrl ?? undefined,
        id: `migration:${completion.digest}`,
      });
    },
  }));
  useEffect(() => (onCompleted ? flow.onCompleted(onCompleted) : undefined), [flow, onCompleted]);
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return <MigrationPanel state={state} venue={venue} signerKinds={signers.kinds} controls={flow} />;
}

function ApprovalReview({ action, controls }: Readonly<{ action: Extract<MigrationFlowState["action"], { phase: "review" }>; controls: Controls }>) {
  return (
    <>
      {action.changes.length > 0 ? (
        <div className={styles.message} role="alert">
          <StatusText tone="caution">The on-chain state changed. Check the new review before you approve.</StatusText>
          <ul className={styles.details}>
            {action.changes.map((change) => (
              <li key={change.key}>
                {change.label}: {change.before ?? "none"} → {change.after ?? "none"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <dl className={styles.facts}>
        {action.review.facts.map((fact) => (
          <div key={fact.key} className={styles.fact}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.actions}>
        <Button variant="primary" className={styles.primary} size="lg" onClick={() => controls.approve(action.review.id)}>
          {action.changes.length > 0 ? "Approve the updated review" : "Approve and sign"}
        </Button>
        <Button onClick={controls.cancel}>Cancel</Button>
      </div>
    </>
  );
}
