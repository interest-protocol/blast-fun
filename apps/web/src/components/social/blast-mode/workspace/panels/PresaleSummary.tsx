import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import type { ReactNode } from "react";
import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import { bpsRatio } from "@blast/core/lib/bps.ts";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { readablePrice } from "#web/lib/market-format.ts";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { QuoteMark } from "#web/components/social/coin-home/glyphs.tsx";
import type { SocialPresaleDetail, SocialPresaleViewerEntry } from "@blast/core/web/contracts/presales.ts";
import { Facepile } from "../ActorCell";
import { personIdentity, type ActorIdentity } from "../actor-identity";
import { Figure, ProgressRing } from "./Figures";
import { PresaleAmount, SalePageLink } from "./PresaleContent";
import { backerIdentity, readableExact } from "./presale-format";
import styles from "./PresalePanel.module.css";
import { fundedText, presaleStage } from "./presale-stage";

/**
 * The funding headline every presale view keeps visible: the ring, the amount
 * raised against its target, and who backed it. Unknown figures read "—".
 * `compact` (the list tabs) folds it into one line so the list keeps the room.
 */
export function PresaleHero({
  detail,
  pending = false,
  viewer = null,
  compact = false,
}: Readonly<{
  detail: SocialPresaleDetail | null;
  pending?: boolean;
  viewer?: SocialPresaleViewerEntry | null;
  compact?: boolean;
}>) {
  const sale = detail?.presale;
  const following = viewer?.following ?? [];
  const parts: HeroParts = {
    sale,
    faces: following.length > 0
      ? following.map((backer) => personIdentity(backer.account))
      : (detail?.backers?.top ?? []).map((backer) => backerIdentity(backer.account, backer.wallet)),
    following: following.length,
    funded: sale ? fundedText(sale.fill_bps) : "—",
    ratio: sale ? bpsRatio(sale.fill_bps) : null,
    ringLabel: sale ? `Funding progress: ${(sale.fill_bps / 100).toFixed(2)}% of the target raised` : "Funding progress unavailable",
    placeholder: (text) => (pending ? <SkeletonText>{text}</SkeletonText> : "—"),
  };
  return compact ? <CompactHero {...parts} /> : <FullHero {...parts} />;
}

type HeroParts = Readonly<{
  sale: SocialPresaleDetail["presale"] | undefined;
  faces: readonly ActorIdentity[];
  following: number;
  funded: string;
  ratio: number | null;
  ringLabel: string;
  placeholder: (text: string) => ReactNode;
}>;

/** The funding target, exact in the inspector. */
function Target({ sale }: Readonly<{ sale: SocialPresaleDetail["presale"] }>) {
  return (
    <b>
      <PresaleAmount atoms={sale.target_atoms} decimals={sale.quote_decimals} symbol={sale.quote_symbol} label="Funding target" />
    </b>
  );
}

function BackerCount({ count }: Readonly<{ count: number }>) {
  return <><b>{count.toLocaleString("en-US")}</b> {count === 1 ? "backer" : "backers"}</>;
}

function CompactHero({ sale, faces, ratio, ringLabel, placeholder }: HeroParts) {
  return (
    <section className={styles.heroCompact} aria-label="Funding">
      <ProgressRing ratio={ratio} size={28} stroke={4} label={ringLabel} />
      <p className={styles.compactLine}>
        {sale ? (
          <>
            <span className={styles.compactRaise}>
              <RaisedFigure sale={sale} inline />
              <QuoteMark symbol={sale.quote_symbol} />
              <span>of <Target sale={sale} /></span>
            </span>
            <span className={styles.compactBackers}>
              <span aria-hidden="true">·</span>
              <Facepile identities={faces} size={22} max={3} />
              <span className={styles.compactCount}>
                <BackerCount count={sale.participants} />
              </span>
            </span>
          </>
        ) : (
          <span>{placeholder("$0,000 of 00,000 USDC · 00 backers")}</span>
        )}
      </p>
    </section>
  );
}

function FullHero({ sale, faces, following, funded, ratio, ringLabel, placeholder }: HeroParts) {
  return (
    <section className={styles.hero} aria-label="Funding">
      <span className={styles.heroRing}>
        <ProgressRing ratio={ratio} size={72} stroke={6} label={ringLabel}>
          <b className={styles.ringPct}>{funded}</b>
          <span className={styles.ringWord}>funded</span>
        </ProgressRing>
      </span>
      <div className={styles.heroText}>
        <div className={styles.raise}>
          <span className={styles.raiseKicker}>Raised · {funded}</span>
          <span className={styles.raiseFigure}>{sale ? <RaisedFigure sale={sale} /> : placeholder("$0,000")}</span>
          <span className={styles.raiseOf}>
            {sale ? (
              <>
                <QuoteMark symbol={sale.quote_symbol} />
                <span className={styles.raiseText}><span className={styles.raiseVerb}>raised </span>of <Target sale={sale} /></span>
              </>
            ) : placeholder("raised of 00,000 USDC")}
          </span>
        </div>
        <p className={styles.backers}>
          <Facepile identities={faces} size={22} max={4} />
          {sale ? (
            <span>
              <BackerCount count={sale.participants} />
              {following > 0 ? <> · <b>{following.toLocaleString("en-US")}</b> you follow</> : null}
            </span>
          ) : (
            <span>{placeholder("00 backers")}</span>
          )}
        </p>
      </div>
    </section>
  );
}

/** The raised amount: the panel's headline figure, or `inline` text in the compact line. Dollars for a USDC sale, else the sale's own coin; exact in the inspector. */
function RaisedFigure({ sale, inline = false }: Readonly<{ sale: SocialPresaleDetail["presale"]; inline?: boolean }>) {
  const hidden = useShellPrefs().amountsHidden;
  const parsed = exactAtoms(sale.raised_atoms, sale.quote_decimals);
  const figure = (text: string) => (inline ? <b className={styles.compactFigure}>{text}</b> : <Figure text={text} size="lg" />);
  if (hidden) return figure("••••");
  if (!parsed) return figure("—");
  const dollars = sale.quote_symbol.toUpperCase() === "USDC";
  const short = readableExact(parsed, sale.quote_decimals);
  return (
    <InspectValue label="Raised" value={`${groupedExact(parsed, sale.quote_decimals)} ${sale.quote_symbol}`}>
      {figure(dollars ? `$${short}` : short)}
      {dollars ? null : <span className={styles.raiseUnit}> {sale.quote_symbol}</span>}
    </InspectValue>
  );
}

/**
 * The facts a backer decides on, as two quiet lines under the hero: the price, then timing and where it trades.
 * Exact values are in the shared inspector; vesting and every other term are on the sale page.
 */
export function PresaleSummary({
  detail,
  now,
  compact = false,
}: Readonly<{ detail: SocialPresaleDetail; /** The panel's live clock. */ now: number; compact?: boolean }>) {
  const { presale: sale, terms } = detail;
  const stage = presaleStage(sale, now);
  const when = saleTiming(sale, stage);
  const timing = stage.label === "Upcoming" && when.at <= 0
    ? <>not scheduled yet</>
    : <>{when.verb} <LineTime at={when.at} label={when.inspect} /></>;
  // Two designed lines: what it costs (with the sale page for every other term), then when and where it trades.
  return (
    <div className={styles.saleLine}>
      <p className={styles.priceLine}>
        <span>
          <SummaryPrice price={terms?.presale_price_quote} quoteSymbol={sale.quote_symbol} symbol={sale.symbol} />
        </span>
        <SalePageLink presaleId={sale.presale_id} />
      </p>
      {(!compact || !["pending", "open"].includes(sale.phase)) && <p>
        <span>{timing}</span>
        {sale.venue ? (
          <>
            <span className={styles.dot}> · </span>
            <span>
              {sale.phase === "trading" ? "trading on" : "trades on"} <DexIdentity iconOnly venue={sale.venue} />
            </span>
          </>
        ) : null}
      </p>}
    </div>
  );
}

function saleTiming(sale: SocialPresaleDetail["presale"], stage: ReturnType<typeof presaleStage>) {
  if (stage.label === "Upcoming") return { verb: "opens", inspect: "opening time", at: sale.start_ms };
  if (sale.phase === "trading") return { verb: "trading since", inspect: "trading start time", at: sale.launched_ms ?? 0 };
  if (stage.label === "Live") return { verb: "closes", inspect: "closing time", at: sale.end_ms };
  if (sale.ended_ms != null) return { verb: "closed", inspect: "closing time", at: sale.ended_ms };
  return { verb: "scheduled close", inspect: "scheduled closing time", at: sale.end_ms };
}

function LineTime({ at, label }: Readonly<{ at: number; label: string }>) {
  return Number.isFinite(at) && at > 0 ? <DateStamp at={at} label={label} /> : <>Unavailable</>;
}

function SummaryPrice({
  price,
  quoteSymbol,
  symbol,
}: Readonly<{
  price: string | null | undefined;
  quoteSymbol: string;
  symbol: string;
}>) {
  const hidden = useShellPrefs().amountsHidden;
  if (price == null) return <span>price unavailable</span>;
  if (hidden) return <span>•••• {quoteSymbol} per {symbol}</span>;
  return (
    <InspectValue
      value={`${price} ${quoteSymbol} per ${symbol}`}
      label="Presale price"
    >
      {readablePrice(price)} {quoteSymbol} per {symbol}
    </InspectValue>
  );
}
