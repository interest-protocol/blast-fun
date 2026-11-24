import { useId } from "react";
import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { ChevronIcon } from "#web/components/blast-ui/Icons.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";
import { ActorCell } from "../ActorCell";
import { readableExact, backerIdentity } from "./presale-format";
import styles from "./PresalePanel.module.css";

export function PresaleAmount({
  atoms,
  decimals,
  symbol,
  label,
  compact = false,
}: Readonly<{
  atoms: string | null | undefined;
  decimals: number;
  symbol: string;
  label: string;
  compact?: boolean;
}>) {
  const hidden = useShellPrefs().amountsHidden;
  if (hidden) return <>••••</>;
  const parsed = atoms == null ? null : exactAtoms(atoms, decimals);
  if (!parsed) return <>Unavailable</>;
  const amount = `${groupedExact(parsed, decimals)} ${symbol}`;
  return (
    <InspectValue label={label} value={amount}>
      {compact ? `${readableExact(parsed, decimals)} ${symbol}` : amount}
    </InspectValue>
  );
}
export function PresaleReadProblem({
  name,
  retry,
}: Readonly<{ name: string; retry: () => void }>) {
  return (
    <p role="alert">
      {name} could not load. Your setup is kept.{" "}
      <Button variant="secondary" size="sm"  type="button" onClick={retry}>
        Retry {name.toLowerCase()}
      </Button>
    </p>
  );
}

export function PresaleContent({
  detail,
  tab,
}: Readonly<{
  detail: SocialPresaleDetail;
  tab: "overview" | "people" | null;
}>) {
  // The Sale tab is the summary lines above (with the sale-page link); only Backers has a list.
  if (tab === "overview") return null;
  if (tab === "people") return <Backers detail={detail} />;
  return <p>No presale view selected.</p>;
}

/** Every other term (supply, recipients, full vesting) lives on the sale page; Blast mode keeps the decision facts. */
export function SalePageLink({ presaleId }: Readonly<{ presaleId: string }>) {
  return (
    <IntentLink className={styles.salePage} href={presalePath(presaleId)}>
      Open sale page
      <ChevronIcon />
    </IntentLink>
  );
}

function Backers({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const sale = detail.presale;
  const top = detail.backers?.top;
  const about = useId();
  return (
    <>
      {/* The compact hero above already counts the backers; the list's scope is its accessible description. */}
      <h3 className="sr">
        {sale.participants.toLocaleString("en-US")} {sale.participants === 1 ? "backer" : "backers"}
      </h3>
      <p className="sr" id={about}>
        Bounded sample: the top {top?.length ?? 0} returned backers, with what each committed. Shares use the
        indexed raise; this is not a complete wallet list.
      </p>
      {!top ? (
        <p>Backers unavailable in this read.</p>
      ) : top.length === 0 ? (
        <p>No backers in the returned sample.</p>
      ) : (
        <ol className={styles.people} aria-describedby={about}>
          {top.map((backer) => (
            <li className={styles.person} key={backer.wallet}>
              <ActorCell identity={backerIdentity(backer.account, backer.wallet)} detail={backer.why ?? undefined} />
              <span className={styles.personAmount}>
                <PresaleAmount
                  compact
                  atoms={backer.commitment_atoms}
                  decimals={sale.quote_decimals}
                  symbol={sale.quote_symbol}
                  label={`backer commitment, ${(backer.share_bps / 100).toFixed(2)}% of raise`}
                />
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
