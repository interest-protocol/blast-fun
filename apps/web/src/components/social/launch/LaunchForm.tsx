"use client";

import { LOGO_GUIDE, walletLabel } from "#web/components/social/create/create-field-model.ts";

import { useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { useRowKeys } from "#web/components/ui-libraries/use-row-keys.ts";
import { Button, DisclosureButton, IconButton } from "#web/components/blast-ui/Button.tsx";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { FileField, SelectField, TextArea } from "#web/components/blast-ui/TextField.tsx";
import { CheckIcon, CloseIcon } from "#web/components/blast-ui/Icons.tsx";
import { BlastMenu, BlastMenuRadioGroup, BlastMenuRadioItem, BlastMenuTrigger } from "#web/components/blast-ui/BlastMenu.tsx";
import { fieldNumber, ppmPct } from "@blast/core/web/format.ts";
import { venueName } from "@blast/core/lib/format.ts";
import { SALE_COVER_MAX_BYTES } from "@blast/core/web/contracts/sales.ts";
import { createQuoteOf } from "@blast/core/web/contracts/create.ts";
import {
  LAUNCH_DESCRIPTION_MAX,
  LAUNCH_MAX_RECIPIENTS,
  LAUNCH_VENUES,
  launchFigures,
  launchRecipientLimit,
  launchSplit,
  launchVenueTiers,
  pct,
  poolQuoteBps,
  sumBps,
  type LaunchDraft,
  type LaunchIssue,
  type LaunchRecipient,
  type LaunchRules,
  type LaunchVenue,
} from "@blast/core/modules/social/launch/model.ts";
import { bareTelegram, bareXHandle } from "@blast/core/modules/social/sales/validate.ts";

import { LockIcon, UploadIcon } from "../create/create-icons";
import { cx } from "../create/cx";
import { CoinMark, CrErr, CrField, CrIn, CrSeg, FoldList, FoldSection, PhoneCoverGuide, SplitSummary, useFold, type Fold } from "../create/fields";
import type { FieldType } from "../create/create-field-model";
import { QuoteMark } from "../create/QuotePicker";
import { splitShades } from "../create/create-colors.ts";
import { compatibleLaunchPool, goToLaunchStep, launchStore, reviewLaunch, shownIssue, type LaunchState } from "./launch-store";
import { compact, poolOpensAtGraduation, poolPriceDifference, quoteLabel } from "./launch-format";
import { lcx } from "./lcx";

type Form = Readonly<{ state: LaunchState; issues: readonly LaunchIssue[]; rules: LaunchRules }>;

const shown = (form: Form, path: string) => shownIssue(form.state, form.issues, path);
const edit = (change: Partial<LaunchDraft>) => launchStore.edit((draft) => ({ ...draft, ...change }));
/** The description count appears from 90% of the limit; `maxLength` stops typing past it. */
const DESCRIPTION_COUNT_FROM = Math.floor(LAUNCH_DESCRIPTION_MAX * 0.9);

type ListKey = "recipients" | "fee_recipients";

function setPath(draft: LaunchDraft, path: string, value: unknown): LaunchDraft {
  const [head, index, key] = path.split(".");
  if (index === undefined) return { ...draft, [head!]: value } as LaunchDraft;
  const list = [...draft[head as ListKey]];
  list[Number(index)] = { ...list[Number(index)]!, [key!]: value };
  return { ...draft, [head!]: list };
}

function valueAt(draft: LaunchDraft, path: string): string | number {
  const [head, index, key] = path.split(".");
  if (index === undefined) return draft[head as keyof LaunchDraft] as string | number;
  return draft[head as ListKey][Number(index)]![key as keyof LaunchRecipient];
}

function Field(props: Readonly<{ form: Form; path: string; type: FieldType; label: string; id?: string; placeholder?: string; maxLength?: number; pre?: ReactNode; suf?: ReactNode; className?: string; normalize?: (value: string) => string; describedBy?: string; size?: "md" | "lg" }>) {
  const { form, path, normalize } = props;
  const error = shown(form, path);
  return (
    <CrIn
      addressError={props.type === "addr" ? error : undefined}
      bad={error !== ""}
      className={props.className}
      describedBy={props.describedBy}
      id={props.id}
      key={props.type === "addr" ? `${form.state.accountId}:${form.state.draftId}` : undefined}
      label={props.label}
      maxLength={props.maxLength}
      onLeave={(left) => launchStore.touch(left)}
      onValue={(value) => launchStore.edit((draft) => setPath(draft, path, normalize && typeof value === "string" ? normalize(value) : value))}
      path={path}
      placeholder={props.placeholder}
      pre={props.pre}
      size={props.size ?? "lg"}
      suf={props.suf}
      type={props.type}
      value={valueAt(form.state.draft, path)}
    />
  );
}

/** A step's card; with `fold`, a secondary card is one row that shows its `value` and opens in place. */
function Card({ id, title, aside, children, fold, value }: Readonly<{ id: string; title: string; aside?: ReactNode; children: ReactNode; fold?: Fold; value?: ReactNode }>) {
  if (fold) {
    return (
      <FoldSection fold={fold} id={id} sectionId={`lc-${id}`} title={title} value={value}>
        {aside ? <p className={cx("cr-detail")}>{aside}</p> : null}
        {children}
      </FoldSection>
    );
  }
  const heading = `lc-${id}-title`;
  return (
    <section aria-labelledby={heading} className={cx("card cr-card cr-g")} data-sec={id} id={`lc-${id}`} tabIndex={-1}>
      {aside ? <div className={cx("cr-card-head")}><h2 id={heading}>{title}</h2><span>{aside}</span></div> : <h2 id={heading}>{title}</h2>}
      {children}
    </section>
  );
}

/** A folded card's row: open while a field in one of its issue sections shows an error. */
function useSectionFold(form: Form, ...sections: readonly LaunchIssue["section"][]): Fold {
  const sectionSet = new Set(sections);
  return useFold(form.issues.filter((issue) => sectionSet.has(issue.section) && shown(form, issue.path) !== "").map((issue) => issue.path).join(" "), 0);
}

/** A locked tile: Blast's share, set by the deployed contracts. */
function Locked({ text }: Readonly<{ text: string }>) {
  return <span className={cx("cr-tile-value locked")}>{text}<span aria-label="Locked, set by Blast" className={cx("cr-lock")} role="img"><LockIcon /></span></span>;
}

/** A figure tile; `value` is its own element (a field, `Locked`, or `Figure`). */
function Tile({ color, label, value, sub, locked }: Readonly<{ color: string; label: string; value: ReactNode; sub?: ReactNode; locked?: boolean }>) {
  return (
    <div className={cx("cr-tile", locked && "locked")}>
      <span className={cx("cr-tile-label")}><span aria-hidden="true" className={cx("dot cr-color")} data-cr-color={color} />{label}</span>
      {value}
      {sub ? <span className={cx("cr-tile-sub")}>{sub}</span> : null}
    </div>
  );
}

const Figure = ({ text }: Readonly<{ text: string }>) => <span className={cx("cr-tile-value")}>{text}</span>;

// ---------- Coin ----------

export function CoinStep({ form, onLogo }: Readonly<{ form: Form; onLogo: (file: File) => void }>) {
  const ids = useId();
  const { draft } = form.state;
  const descriptionError = shown(form, "description");
  const logo = form.state.logoPreview ?? form.state.logoUrl;
  const file = useRef<HTMLInputElement>(null);
  const [advanced, setAdvanced] = useState(false);
  const open = advanced || shown(form, "decimals") !== "" || shown(form, "sell_burn_bps") !== "";
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (picked) onLogo(picked);
  };
  return (
    <>
    <Card id="coin" title="Coin">
      <div className={cx("cr-ident")}>
        <div className={cx("cr-logo-col")}>
          <IconButton aria-label={logo ? "Replace logo" : "Upload logo"} className={`${cx("cr-logo")} ${lcx("lc-logo")}`} data-f="logo" onClick={() => file.current?.click()} variant="ghost">
            <CoinMark draft={{ name: "" }} logo={logo} size="s112" />
            <span aria-hidden="true" className={cx("cr-logo-badge")}><UploadIcon /></span>
          </IconButton>
          <FileField accept="image/png,image/jpeg,image/webp" hidden onChange={pick} ref={file} />
          <span aria-hidden="true" className={cx("cr-logo-title")}>{logo ? "Replace logo" : "Upload logo"}</span>
          <span className={cx("cr-logo-note")}>{LOGO_GUIDE}</span>
          <CrErr message={shown(form, "logo")} path="logo" />
        </div>
        <div className={cx("cr-ident-fields")}>
          <CrField error={<CrErr message={shown(form, "name")} path="name" />} htmlFor={`${ids}-name`} label="Name">
            <Field form={form} id={`${ids}-name`} label="Name" maxLength={64} path="name" placeholder="e.g. Pip" type="text" />
          </CrField>
          <CrField error={<CrErr message={shown(form, "symbol")} path="symbol" />} htmlFor={`${ids}-sym`} label="Ticker">
            <Field form={form} id={`${ids}-sym`} label="Ticker" maxLength={32} path="symbol" placeholder="e.g. PIP" pre="$" type="sym" />
          </CrField>
        </div>
      </div>
      {/* MA-5/TS-1: the count shows only near the limit, and the box is two lines on phones, so Advanced clears the sticky Continue at 390 x 844. */}
      <CrField error={<CrErr message={descriptionError} path="description" />} help={draft.description.length >= DESCRIPTION_COUNT_FROM ? `${fieldNumber(draft.description.length)} / ${fieldNumber(LAUNCH_DESCRIPTION_MAX)}` : undefined} htmlFor={`${ids}-desc`} label="Description">
        <TextArea
          aria-describedby={descriptionError ? "cr-error-description" : undefined}
          aria-invalid={descriptionError !== "" || undefined}
          className={lcx("lc-desc")}
          data-f="description"
          id={`${ids}-desc`}
          maxLength={LAUNCH_DESCRIPTION_MAX}
          onBlur={() => launchStore.touch("description")}
          onChange={(event) => edit({ description: event.currentTarget.value })}
          rows={2}
          value={draft.description}
        />
      </CrField>
      {/* MA-5: the rarely changed supply settings fold into Advanced, so the card and Continue fit one phone screen. */}
      <div className={cx("cr-disclosure-group")}>
        <DisclosureButton aria-controls={`${ids}-advanced`} aria-expanded={open} className={cx("cr-disclosure")} onClick={() => setAdvanced(!open)}>
          <span>Advanced <span className={cx("cr-disclosure-note")}>· {draft.burnable ? "burn only" : "fixed supply"} · {draft.decimals} decimals · sell burn {pct(draft.sell_burn_bps)}</span></span>
        </DisclosureButton>
        <Collapse id={`${ids}-advanced`} open={open}>
          <div className={cx("cr-collapse-body cr-grid")}>
            <CrField help="Fixed for every launch." label="Total supply">
              <span className={lcx("lc-static")}>1,000,000,000 <span>{draft.symbol || "tokens"}</span></span>
            </CrField>
            <CrField help={draft.burnable ? "Unsold curve tokens are burned at graduation." : "Unsold curve tokens are locked forever at graduation."} label="After launch">
              <CrSeg label="Supply after launch" onChange={(burnable) => edit({ burnable })} options={[[false, "Fixed"], [true, "Burn only"]]} value={draft.burnable} />
            </CrField>
            <CrField error={<CrErr message={shown(form, "decimals")} path="decimals" />} label="Decimals">
              <CrSeg label="Token decimals" onChange={(decimals) => edit({ decimals })} options={form.rules.meme_decimals.map((decimals) => [decimals, String(decimals)] as const)} value={draft.decimals} />
            </CrField>
            <CrField error={<CrErr message={shown(form, "sell_burn_bps")} path="sell_burn_bps" />} help="Burned from every sell on the curve. Up to 50%." htmlFor={`${ids}-burn`} label="Sell burn">
              <Field form={form} id={`${ids}-burn`} label="Sell burn" path="sell_burn_bps" suf="%" type="pct" />
            </CrField>
          </div>
        </Collapse>
      </div>
    </Card>
    <div className={cx("cr-actions cr-sticky-action")}>
      <Button loading={form.state.phase === "loading"} loadingLabel="Loading your draft" onClick={() => goToLaunchStep("curve")} variant="primary">Continue to curve</Button>
    </div>
    </>
  );
}

// ---------- Curve ----------

function RecipientRows({ form, list, label, add, color }: Readonly<{ form: Form; list: ListKey; label: string; add: string; color: string }>) {
  const rows = form.state.draft[list];
  const limit = list === "recipients" ? launchRecipientLimit(form.state.draft, form.rules) : LAUNCH_MAX_RECIPIENTS;
  const rowKeys = useRowKeys(rows.length);
  const keyedRows = rows.map((row, index) => ({ row, rowKey: rowKeys.keys[index] }));
  const remove = (index: number) => {
    rowKeys.drop(index);
    launchStore.edit((draft) => ({ ...draft, [list]: draft[list].filter((_, at) => at !== index) }));
  };
  const append = () => launchStore.edit((draft) => ({ ...draft, [list]: [...draft[list], { label: "", address: "", bps: 0 }] }));
  return (
    <div className={`${cx("cr-recs")} ${lcx("lc-recs")}`}>
      {rows.length > 0 ? <div aria-hidden="true" className={cx("cr-columns cr-tile-label")}><span /><span>Name</span><span>Wallet</span><span>Share</span><span /></div> : null}
      {keyedRows.map(({ row, rowKey }, index) => (
        <div className={cx("cr-rec-group")} key={rowKey}>
          <div className={cx("cr-rec")} data-rec={`${list}.${index}`}>
            <span aria-hidden="true" className={cx("dot cr-color")} data-cr-color={color} />
            <Field form={form} label={`${label}: name`} maxLength={40} path={`${list}.${index}.label`} placeholder="Name" size="md" type="text" />
            <Field className="cr-addr" form={form} label={`${label}: ${walletLabel(row.label || "recipient")}`} path={`${list}.${index}.address`} size="md" type="addr" />
            <Field className="cr-pct" form={form} label={`${label}: ${row.label || "recipient"} share`} path={`${list}.${index}.bps`} size="md" suf="%" type="pct" />
            <IconButton aria-label={`Remove ${row.label || "recipient"}`} className={cx("cr-x")} onClick={() => remove(index)}><CloseIcon strokeWidth="2" /></IconButton>
          </div>
          <CrErr message={shown(form, `${list}.${index}.address`) ? "" : shown(form, `${list}.${index}.bps`)} path={`${list}.${index}.bps`} />
        </div>
      ))}
      <div className={cx("cr-add")}>
        <Button disabled={rows.length >= limit || (list === "recipients" && launchSplit(form.state.draft, form.rules).unallocated_bps === 0)} onClick={append} size="sm">{add}</Button>
        <span>Up to {limit}</span>
      </div>
    </div>
  );
}

/**
 * The curve's raise coin: one dropdown (the presale's `cr-quote` button) whose
 * menu lists every coin the deployed launchpad admits, each with its mark,
 * ticker and name, the chosen one checked. A row of seven segments would not
 * fit, and a tab row offers at most three choices.
 */
function QuoteChoice({ form }: Readonly<{ form: Form }>) {
  const { draft } = form.state;
  const chosen = quoteLabel(draft.quote_type);
  return (
    <CrField error={<CrErr message={shown(form, "quote_type")} path="quote_type" />} label="Raise in">
      <BlastMenu
        className={lcx("lc-quote-menu")}
        label="Raise in"
        placement={() => ({ side: "bottom", align: "start", sideOffset: 6, avoid: "flip", originX: "1.5rem" })}
        trigger={
          <BlastMenuTrigger
            aria-label={`Raise in ${chosen}. Change`}
            className={cx("cr-quote")}
            data-f="quote_type"
            disabled={form.rules.quotes.length < 2}
            render={<DisclosureButton><QuoteMark size={24} symbol={chosen} />{chosen}</DisclosureButton>}
          />
        }
      >
        <BlastMenuRadioGroup onValueChange={(quote_type: string) => edit({ quote_type, ...compatibleLaunchPool(draft, form.rules, quote_type) })} value={draft.quote_type}>
          {form.rules.quotes.map((quote) => (
            <BlastMenuRadioItem closeOnClick className={lcx("lc-quote-option")} key={quote} label={quoteLabel(quote)} value={quote}>
              <QuoteMark size={28} symbol={quoteLabel(quote)} />
              <span className={lcx("lc-quote-name")}>
                <b>{quoteLabel(quote)}</b>
                <span>{createQuoteOf(quote)?.name ?? ""}</span>
              </span>
              {quote === draft.quote_type ? <CheckIcon strong /> : null}
            </BlastMenuRadioItem>
          ))}
        </BlastMenuRadioGroup>
      </BlastMenu>
    </CrField>
  );
}

function TokenSplit({ form }: Readonly<{ form: Form }>) {
  const ids = useId();
  const { draft } = form.state;
  const split = launchSplit(draft, form.rules);
  const figures = launchFigures(draft, form.rules);
  const unsold = draft.burnable ? "Unsold, burned at graduation" : "Unsold, locked forever at graduation";
  const [sold, unsoldShade, pool, recipients, unused, blast] = splitShades([split.sold_bps, split.unsold_bps, split.pool_bps, split.allocated_bps, split.unallocated_bps, split.protocol_bps]) as readonly string[];
  const controls = [
    { path: "curve_bps", label: "On the curve", help: `Unsold curve tokens are ${draft.burnable ? "burned" : "locked forever"} at graduation.` },
    { path: "pool_bps", label: "In the liquidity pool", help: "Sets the pool’s opening price." },
  ] as const;
  const fold = useSectionFold(form, "split");
  const recipientCount = draft.recipients.length;
  return (
    <Card aside={`1,000,000,000 ${draft.symbol || "tokens"}`} fold={fold} id="split" title="Token split" value={`Curve ${pct(split.curve_bps)}, pool ${pct(split.pool_bps)}${recipientCount ? `, +${recipientCount}` : ""}`}>
      <div className={cx("cr-grid")}>
        {controls.map(({ path, label, help }) => (
          <CrField error={<CrErr message={shown(form, path)} path={path} />} help={help} htmlFor={`${ids}-${path}`} key={path} label={label}>
            <Field form={form} id={`${ids}-${path}`} label={`${label}: exact share of supply`} path={path} suf="%" type="pct" />
          </CrField>
        ))}
      </div>
      <div className={lcx("lc-token-bar")}><SplitSummary bps={split.curve_bps + split.pool_bps + split.allocated_bps + split.protocol_bps + split.unallocated_bps} parts={[[split.sold_bps, sold!, "Sold"], [split.unsold_bps, unsoldShade!, unsold], [split.pool_bps, pool!, "Liquidity pool"], [split.allocated_bps, recipients!, "Recipients"], [split.unallocated_bps, unused!, "Unused, locked forever at graduation"], [split.protocol_bps, blast!, "Blast"]]} /></div>
      <div className={cx("cr-tiles")}>
        {figures && !(poolOpensAtGraduation(figures.pool, figures.terminal) && poolOpensAtGraduation(figures.poolAtCurveSupply, figures.terminal)) ? <Tile color={pool!} label="Pool opening" value={<Figure text={`${compact(figures.pool)}\u00a0${quoteLabel(draft.quote_type)}`} />} sub={<>FDV · {poolPriceDifference(figures.poolAtCurveSupply, figures.terminal)}</>} /> : null}
        <Tile color={unused!} label="Unused" value={<Figure text={pct(split.unallocated_bps)} />} sub="Locked forever at graduation" />
        <Tile color={blast!} label="Blast" locked sub="Paid at graduation" value={<Locked text={pct(split.protocol_bps)} />} />
      </div>
      <CrField help="Taken from the unused share." label="Recipients (optional)">
        <CrErr message={shown(form, "recipients")} path="recipients" />
        <RecipientRows add="Add recipient" color={recipients!} form={form} label="Token split" list="recipients" />
      </CrField>
    </Card>
  );
}

export function CurveStep({ form }: Readonly<{ form: Form }>) {
  const ids = useId();
  const { draft } = form.state;
  const { rules } = form;
  const figures = launchFigures(draft, rules);
  const unit = quoteLabel(draft.quote_type);
  const tiers = launchVenueTiers(rules, draft.venue, draft.quote_type);
  const feeTotal = draft.creator_fee_bps + draft.holders_fee_bps + draft.auto_lp_fee_bps + draft.burn_fee_bps + sumBps(draft.fee_recipients);
  const [raisePool, raiseBlast] = splitShades([poolQuoteBps(rules), rules.protocol_quote_bps]) as readonly string[];
  const [you, holders, autoLp, burn, feeRecipients] = splitShades([draft.creator_fee_bps, draft.holders_fee_bps, draft.auto_lp_fee_bps, draft.burn_fee_bps, sumBps(draft.fee_recipients)]) as readonly string[];
  const venueHelp = (venue: LaunchVenue) => launchVenueTiers(rules, venue, draft.quote_type).length > 0;
  // The Curve card stays open; the rest fold into rows that show their values, and a shown error opens its row.
  const poolFold = useSectionFold(form, "pool");
  const tradingFold = useSectionFold(form);
  const raiseFold = useSectionFold(form);
  const feesFold = useSectionFold(form, "fees");
  return (
    <>
      <Card id="curve" title="Curve">
        <QuoteChoice form={form} />
        <div className={`${cx("cr-grid")} ${lcx("lc-curve-grid")}`}>
          <CrField error={<CrErr message={shown(form, "virtual_quote")} path="virtual_quote" />} help="Virtual, never paid in." htmlFor={`${ids}-v`} label="Starting liquidity">
            <Field form={form} id={`${ids}-v`} label="Starting liquidity" path="virtual_quote" suf={unit} type="money" />
          </CrField>
          <CrField error={<CrErr message={shown(form, "graduation_target")} path="graduation_target" />} htmlFor={`${ids}-t`} label="Raise target">
            <Field form={form} id={`${ids}-t`} label="Raise target" path="graduation_target" suf={unit} type="money" />
          </CrField>
        </div>
        {figures ? (
          <dl className={lcx("lc-figures")}>
            <div><dt>Starts at</dt><dd>{compact(figures.opening)}{"\u00a0"}{unit}</dd><dd>FDV</dd></div>
            <div><dt>Graduates at</dt><dd>{compact(figures.terminal)}{"\u00a0"}{unit}</dd><dd>FDV</dd></div>
          </dl>
        ) : null}
      </Card>

      <FoldList>
        <Card fold={poolFold} id="pool" title="Pool" value={`${venueName(draft.venue)}, ${ppmPct(draft.pool_fee)} fee`}>
          <div className={cx("cr-grid")}>
            <CrField error={<CrErr message={shown(form, "venue")} path="venue" />} label="Venue">
              <CrSeg
                disabled={(venue) => !venueHelp(venue)}
                label="Pool venue"
                onChange={(venue) => {
                  const fees = launchVenueTiers(rules, venue, draft.quote_type);
                  edit({ venue, pool_fee: fees.some(([, fee]) => fee === draft.pool_fee) ? draft.pool_fee : fees.at(-1)?.[1] ?? draft.pool_fee });
                }}
                options={LAUNCH_VENUES.map((venue) => [venue, <DexIdentity key={venue} venue={venue} />] as const)}
                value={draft.venue}
              />
            </CrField>
            <CrField error={<CrErr message={shown(form, "pool_fee")} path="pool_fee" />} help={tiers.length === 0 ? "No pool fee is available for this coin here." : `Only fees the venue offers for ${unit}.`} htmlFor={`${ids}-fee`} label="Pool fee">
              <SelectField data-f="pool_fee" disabled={tiers.length === 0} id={`${ids}-fee`} onChange={(event) => edit({ pool_fee: Number(event.currentTarget.value) })} size="lg" value={draft.pool_fee}>
                {!tiers.some(([, fee]) => fee === draft.pool_fee) ? <option disabled value={draft.pool_fee}>{ppmPct(draft.pool_fee)} (unavailable)</option> : null}
                {tiers.map(([, fee]) => <option key={fee} value={fee}>{ppmPct(fee)}</option>)}
              </SelectField>
            </CrField>
          </div>
        </Card>

        <Card fold={tradingFold} id="trading" title="Curve trading fees" value={`You get ${pct(10_000 - rules.protocol_fee_share_bps)}`}>
          <p className={cx("cr-detail")}>Fee {pct(rules.quote_fee_bps)} of {unit} + {pct(rules.meme_fee_bps)} of {draft.symbol || "the token"} · Blast {pct(rules.protocol_fee_share_bps)} · Collect in Portfolio → Rewards</p>
        </Card>

        <TokenSplit form={form} />

        <Card aside={`${fieldNumber(draft.graduation_target)} ${unit} target`} fold={raiseFold} id="raise" title="Raise split" value={`Pool ${pct(poolQuoteBps(rules))}, Blast ${pct(rules.protocol_quote_bps)}`}>
          <SplitSummary bps={10_000} parts={[[poolQuoteBps(rules), raisePool!, "Liquidity pool"], [rules.protocol_quote_bps, raiseBlast!, "Blast"]]} />
          <div className={cx("cr-tiles")}>
            <Tile color={raisePool!} label="Liquidity pool" locked sub={figures ? `${compact(figures.poolQuote)} ${unit}, paired with ${compact(figures.poolTokens)} ${draft.symbol || "tokens"}` : undefined} value={<Figure text={pct(poolQuoteBps(rules))} />} />
            <Tile color={raiseBlast!} label="Blast" locked sub="Paid at graduation" value={<Locked text={pct(rules.protocol_quote_bps)} />} />
          </div>
        </Card>

        <Card aside="After graduation, forever" fold={feesFold} id="fees" title="Pool fees" value={`You ${pct(draft.creator_fee_bps)}, holders ${pct(draft.holders_fee_bps)}`}>
          <p className={lcx("lc-blast-first")}>Blast takes {pct(rules.pool_fee_quote_bps)} of {unit} fees and {pct(rules.pool_fee_meme_bps)} of {draft.symbol || "token"} fees first.</p>
          <SplitSummary bps={feeTotal} parts={[[draft.creator_fee_bps, you!, "You"], [draft.holders_fee_bps, holders!, "Holders"], [draft.auto_lp_fee_bps, autoLp!, "Auto-LP"], [draft.burn_fee_bps, burn!, "Buyback & burn"], [sumBps(draft.fee_recipients), feeRecipients!, "Recipients"]]} />
          <div className={`${cx("cr-tiles")} ${lcx("lc-tiles4")}`}>
            <Tile color={you!} label="You" sub="Collect in Portfolio → Rewards" value={<Field className="cr-pct" form={form} label="Your share of pool fees" path="creator_fee_bps" size="md" suf="%" type="pct" />} />
            <Tile color={holders!} label="Holders" sub="Daily rewards to holders" value={<Field className="cr-pct" form={form} label="Holders' share of pool fees" path="holders_fee_bps" size="md" suf="%" type="pct" />} />
            <Tile color={autoLp!} label="Auto-LP" sub="Added back to the pool" value={<Field className="cr-pct" form={form} label="Auto-LP share of pool fees" path="auto_lp_fee_bps" size="md" suf="%" type="pct" />} />
            <Tile color={burn!} label="Buyback & burn" sub={`${draft.symbol || "Token"} fees burned; ${unit} fees buy ${draft.symbol || "it"} back to burn`} value={<Field className="cr-pct" form={form} label="Buyback and burn share of pool fees" path="burn_fee_bps" size="md" suf="%" type="pct" />} />
          </div>
          <CrErr message={shown(form, "fee_total")} path="fee_total" />
          <RecipientRows add="Add fee recipient" color={feeRecipients!} form={form} label="Pool fees" list="fee_recipients" />
        </Card>
      </FoldList>

      <div className={cx("cr-actions cr-sticky-action")}>
        <Button onClick={() => goToLaunchStep("coin")} variant="secondary">Back</Button>
        <Button onClick={() => goToLaunchStep("details")} variant="primary">Continue to details</Button>
      </div>
    </>
  );
}

// ---------- Details ----------

export function DetailsStep({ form, onCover, onCoverRemove }: Readonly<{ form: Form; onCover: (file: File) => void; onCoverRemove: () => void }>) {
  const phone = usePhoneLayout();
  const ids = useId();
  const cover = form.state.coverPreview ?? form.state.cover?.url ?? null;
  const file = useRef<HTMLInputElement>(null);
  const [linksOpen, setLinksOpen] = useState(false);
  const showLinks = linksOpen || ["site", "x_handle", "telegram", "docs_url", "audit_url"].some((path) => shown(form, path));
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (picked) onCover(picked);
  };
  return (
    <>
    <Card id="details" title="Details">
      <CrField label="Cover">
        <div className={cx("cr-cover-head")}>
          <Button aria-label={cover ? "Replace cover image" : "Upload cover image"} onClick={() => file.current?.click()} size="sm">{cover ? "Replace" : "Upload"}</Button>
          {cover ? <Button onClick={onCoverRemove} size="sm">Remove</Button> : null}
        </div>
        <FileField accept="image/png,image/jpeg,image/webp" hidden onChange={pick} ref={file} />
        {phone ? <PhoneCoverGuide /> : null}
        <div className={cx("cr-cover-frame", cover && "has-cover")}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the uploaded cover, any https host */}
          {cover ? <img alt="Uploaded cover preview" height={512} src={cover} width={1_536} /> : null}
          <span aria-hidden="true" className={cx("cr-safe")} /><span className={cx("cr-safe-label")}>Centre safe area</span>
        </div>
        {!phone ? <span className={cx("cr-help")}><b>3072 × 1024 px</b> (3:1), at least 1536 × 512 · JPG, PNG or WebP, up to {Math.round(SALE_COVER_MAX_BYTES / 1_000_000)} MB. Keep logos inside the centre safe area.</span> : null}
      </CrField>
      <CrField error={<CrErr message={shown(form, "tagline")} path="tagline" />} help={<span className={lcx("lc-help-row")}><span>Shown on cards and the coin page</span><span>{form.state.draft.tagline.length} / 80</span></span>} htmlFor={`${ids}-tag`} label="Short description">
        <TextArea aria-describedby={shown(form, "tagline") ? "cr-error-tagline" : undefined} aria-invalid={shown(form, "tagline") !== "" || undefined} data-f="tagline" id={`${ids}-tag`} maxLength={80} onBlur={() => launchStore.touch("tagline")} onChange={(event) => edit({ tagline: event.currentTarget.value })} placeholder="e.g. The smallest seed on Sui." rows={2} value={form.state.draft.tagline} />
      </CrField>
      <div className={cx("cr-disclosure-group")}>
      <DisclosureButton aria-controls={`${ids}-links`} aria-expanded={showLinks} className={cx("cr-disclosure")} onClick={() => setLinksOpen(!showLinks)}>Links</DisclosureButton>
      <Collapse id={`${ids}-links`} open={showLinks}>
      <div className={cx("cr-collapse-body cr-grid")}>
        <CrField error={<CrErr message={shown(form, "site")} path="site" />} htmlFor={`${ids}-site`} label="Website">
          <Field form={form} id={`${ids}-site`} label="Website" path="site" placeholder="pip.fun" type="text" />
        </CrField>
        <CrField error={<CrErr message={shown(form, "x_handle")} path="x_handle" />} htmlFor={`${ids}-x`} label="X">
          <Field form={form} id={`${ids}-x`} label="X handle" normalize={bareXHandle} path="x_handle" placeholder="handle" pre="@" type="text" />
        </CrField>
        <CrField error={<CrErr message={shown(form, "telegram")} path="telegram" />} htmlFor={`${ids}-tg`} label="Telegram">
          <Field form={form} id={`${ids}-tg`} label="Telegram" normalize={bareTelegram} path="telegram" pre="t.me/" type="text" />
        </CrField>
        <CrField error={<CrErr message={shown(form, "docs_url")} path="docs_url" />} htmlFor={`${ids}-docs`} label="Docs">
          <Field form={form} id={`${ids}-docs`} label="Docs" path="docs_url" type="text" />
        </CrField>
        <CrField className={lcx("lc-wide")} error={<CrErr message={shown(form, "audit_url")} path="audit_url" />} htmlFor={`${ids}-audit`} label="Audit report">
          <Field form={form} id={`${ids}-audit`} label="Audit report" path="audit_url" placeholder="Link to the PDF or page" type="text" />
        </CrField>
      </div>
      </Collapse>
      </div>
    </Card>
    <div className={cx("cr-actions cr-sticky-action")}>
      <Button onClick={() => goToLaunchStep("curve")} variant="secondary">Back</Button>
      <Button onClick={() => reviewLaunch(form.issues)} variant="primary">Continue to review</Button>
    </div>
    </>
  );
}

export type { Form as LaunchForm };
export { Card as LaunchCard, Field as LaunchField };
