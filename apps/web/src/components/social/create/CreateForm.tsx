"use client";

import { LOGO_GUIDE } from "#web/components/social/create/create-field-model.ts";

import { splitShades } from "./create-colors.ts";

import { quoteDisplaySymbol } from "./quote-coins";

import { Button, DisclosureButton, IconButton } from "#web/components/blast-ui/Button.tsx";
import { FileField, SelectField, TextArea, TextField } from "#web/components/blast-ui/TextField.tsx";
import { bluefinTierSupported } from "@blast/core/modules/social/create/bluefin-options.ts";
import { cetusTiersForQuote } from "@blast/core/modules/social/create/cetus-options.ts";

import { useFeedbackReveal } from "#web/components/blast-ui/feedback-motion.ts";

import { focusNextFrame } from "#web/lib/deferred-focus.ts";
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { VESTING_UNIT_LABEL } from "@blast/core/web/contracts/vesting.ts";
import { fieldNumber, ppmPct, shortAddress, usd, utc } from "@blast/core/web/format.ts";
import { CREATE_TAGLINE_MAX, CREATE_DECIMALS, CREATE_LIFT_HOURS, CREATE_LP_DAYS, CREATE_MAX_FEE_RECIPIENTS, CREATE_MAX_RECIPIENTS, CREATE_MAX_WALLETS, CREATE_START_MAX_AHEAD_MS, createMaxSupply, type CreateBuyerVesting, type CreateDraft, type CreateFeeRecipient, type CreateIssue, type CreateRecipient } from "@blast/core/web/contracts/create.ts";
import { allowlistFitsQuote, draftQuote, draftTerms, emptyFeeRecipient, emptyRecipient, liftSlots, pctText, sumBps, venueTiers } from "@blast/core/modules/social/create/model.ts";
import { presaleTargetDecimals } from "@blast/core/modules/social/create/minimum-raise.ts";
import { bareTelegram, bareXHandle } from "@blast/core/modules/social/sales/validate.ts";
import { SALE_COVER_MAX_BYTES } from "@blast/core/web/contracts/sales.ts";

import { allowlistForChecks, createStore, selectedRaiseQuoteUsd, type CreateState } from "./create-store";
import { DoneIcon, LockIcon, UploadIcon } from "./create-icons";
import { CloseIcon } from "#web/components/blast-ui/Icons.tsx";
import { cx } from "./cx";
import { draftMoney, draftShort, draftTarget, quoteAffix } from "./create-money";
import { AllocationStep, CoinMark, CrErr, CrField, CrIn, CrSeg, CrSwitch, FoldList, FoldSection, PhoneCoverGuide, SplitSummary, useFold, type Fold } from "./fields";
import { COVER_GUIDE, coverHint, parseStartField, saleDayOptions, startFieldText, vestingUnitOptions, walletLabel, type FieldType } from "./create-field-model";
import { QuoteMark } from "./QuotePicker";
import { availablePickerQuotes, quoteRowHelp, quoteUnavailableReason, venueAvailable } from "./quote-coins";
import { goToStep, review } from "./create-navigation";

import { AllowlistCard, type AllowlistActions } from "./AllowlistCard";

const DAY = 86_400_000;
const LIFT_LABELS: Readonly<Record<number, string>> = { 1: "Last hour", 6: "Last 6 hours", 24: "Last day" };

type Form = Readonly<{
  state: CreateState;
  issues: readonly CreateIssue[];
  /** The error a field shows now: after it was left once, or after Review was pressed. */
  shown: (path: string) => string;
}>;

/** Sets the value at a dotted path of the draft (`token_recipients.0.address`). */
function setPath(draft: CreateDraft, path: string, value: unknown): CreateDraft {
  const [head, index, field] = path.split(".");
  if (index === undefined) return { ...draft, [head!]: value } as CreateDraft;
  if (head === "buyer_vesting") return { ...draft, buyer_vesting: { ...draft.buyer_vesting, [index]: value } } as CreateDraft;
  const list = [...(draft[head as keyof CreateDraft] as readonly Record<string, unknown>[])];
  list[Number(index)] = { ...list[Number(index)], [field!]: value };
  return { ...draft, [head!]: list } as CreateDraft;
}

function valueAt(draft: CreateDraft, path: string): string | number {
  const [head, index, field] = path.split(".");
  if (index === undefined) return draft[head as keyof CreateDraft] as string | number;
  if (head === "buyer_vesting") return draft.buyer_vesting[index as keyof CreateBuyerVesting] as string | number;
  return (draft[head as keyof CreateDraft] as unknown as readonly Record<string, string | number>[])[Number(index)]![field!]!;
}

function Field(props: Readonly<{
  form: Form;
  path: string;
  type: FieldType;
  label: string;
  placeholder?: string;
  maxLength?: number;
  max?: number;
  precision?: number;
  pre?: ReactNode;
  suf?: ReactNode;
  className?: string;
  /** What a typed value is kept as (R3-25: a pasted X or Telegram link becomes the bare handle). */
  normalize?: (value: string) => string;
  /** The input's id, for a visible `<label htmlFor>` naming it. */
  id?: string;
  size?: "sm" | "md" | "lg";
  describedBy?: string;
}>) {
  const { form, path, normalize } = props;
  const error = form.shown(path);
  return (
    <CrIn
      addressError={props.type === "addr" ? error : undefined}
      bad={error !== ""}
      className={props.className}
      describedBy={props.describedBy}
      id={props.id}
      key={props.type === "addr" ? `${form.state.ownerId}:${form.state.draftId}` : undefined}
      label={props.label}
      max={props.max}
      maxLength={props.maxLength}
      onLeave={(leftPath) => createStore.touch(leftPath)}
      onValue={(value) => createStore.edit((draft) => setPath(draft, path, normalize && typeof value === "string" ? normalize(value) : value))}
      path={path}
      placeholder={props.placeholder}
      pre={props.pre}
      precision={props.precision}
      size={props.size ?? "lg"}
      suf={props.suf}
      type={props.type}
      value={valueAt(form.state.draft, path)}
    />
  );
}

const edit = (change: Partial<CreateDraft>) => createStore.edit((draft) => ({ ...draft, ...change }));

/** R3-42: the draft's coin symbol (`USDC`, `SUI`). */
const quoteSymbol = (draft: CreateDraft) => quoteDisplaySymbol(draftQuote(draft).symbol);

const symOf = (draft: CreateDraft) => draft.symbol || "tokens";

/** A whole-token amount in full (`500,000,000`), as the boards print supplies. */
const tokens = (amount: number) => fieldNumber(Math.floor(amount));

/**
 * One card of a step (`.card`): its id is the old section link (`#cr-raise`), so links into the page still land.
 * With `fold`, a secondary card is one row that shows its `value` and opens in place.
 */
function Card({ id, title, aside, children, className, fold, value }: Readonly<{ id: string; title: string; aside?: ReactNode; children: ReactNode; className?: string; fold?: Fold; value?: ReactNode }>) {
  if (fold) {
    return (
      <FoldSection fold={fold} id={id} sectionId={`cr-${id}`} title={title} value={value}>
        {aside ? <p className={cx("cr-detail")}>{aside}</p> : null}
        {children}
      </FoldSection>
    );
  }
  const heading = `cr-${id}-title`;
  return (
    <section aria-labelledby={heading} className={cx("card cr-card cr-g", className)} data-sec={id} id={`cr-${id}`} tabIndex={-1}>
      {aside ? (
        <div className={cx("cr-card-head")}>
          <h2 id={heading}>{title}</h2>
          <span>{aside}</span>
        </div>
      ) : <h2 id={heading}>{title}</h2>}
      {children}
    </section>
  );
}

/**
 * A disclosure the page opens itself when it sends the creator to a field
 * inside (a fix) or the field shows an error; the creator can still fold it.
 */
function useDisclosure(form: Form, inside: (path: string) => boolean, initial: boolean) {
  const [choice, setChoice] = useState<Readonly<{ open: boolean | null; closedAt: number }>>({ open: null, closedAt: 0 });
  const flash = form.state.flash;
  const flashNonce = flash && inside(flash.path) ? flash.nonce : 0;
  const erring = form.issues.some((issue) => inside(issue.path) && form.shown(issue.path) !== "");
  const open = flashNonce > choice.closedAt || (choice.open ?? (initial || erring));
  return { open, toggle: () => setChoice({ open: !open, closedAt: flashNonce }) };
}

/** A folded card's row: open while a field inside (named by its issue's section and path) shows an error or a fix lands in it. */
function useCardFold(form: Form, inside: (section: string, path: string) => boolean): Fold {
  const flash = form.state.flash;
  const errors = form.issues.filter((issue) => inside(issue.section, issue.path) && form.shown(issue.path) !== "").map((issue) => issue.path).join(" ");
  return useFold(errors, flash && inside(flash.section, flash.path) ? flash.nonce : 0);
}

const inBuyerVesting = (path: string) => path.startsWith("buyer_vesting");

/** ", +2" (two more recipients) after a folded split's shares, so the row stays one line; nothing without any. */
const recipientsNote = (count: number) => (count ? `, +${count}` : "");

// ---------- Token ----------

function TokenStep({ form, onLogo }: Readonly<{ form: Form; onLogo: (file: File) => void }>) {
  const { draft } = form.state;
  // Each visible label names its field by id.
  const ids = useId();
  const logo = form.state.logoPreview ?? form.state.logoUrl;
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) onLogo(file);
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const advanced = useDisclosure(form, (path) => path === "decimals", false);
  const symbolOk = draft.symbol !== "" && !form.issues.some((issue) => issue.path === "symbol");
  return (
    <>
    <Card className="cr-token" id="token" title="Coin">
      <div className={cx("cr-ident")}>
        <div className={cx("cr-logo-col")}>
          <button aria-label={logo ? "Replace logo" : "Upload logo"} className={cx("cr-logo")} data-cr-upload="" onClick={() => fileInput.current?.click()} type="button">
            <CoinMark draft={{ name: "" }} logo={logo} size="s112" />
            <span aria-hidden="true" className={cx("cr-logo-badge")}>
              <UploadIcon />
            </span>
          </button>
          <FileField accept="image/png,image/jpeg,image/webp" hidden onChange={pick} ref={fileInput} />
          <span aria-hidden="true" className={cx("cr-logo-title")}>{logo ? "Replace logo" : "Upload logo"}</span>
          <span className={cx("cr-logo-note")}>{LOGO_GUIDE}</span>
        </div>
        <div className={cx("cr-ident-fields")}>
          <CrField error={<CrErr message={form.shown("name")} path="name" />} htmlFor={`${ids}-name`} label="Name">
            <Field form={form} id={`${ids}-name`} label="Name" maxLength={32} path="name" placeholder="e.g. Meridian" size="lg" type="text" />
          </CrField>
          <CrField error={<CrErr message={form.shown("symbol")} path="symbol" />} help={symbolOk && !form.shown("symbol") ? <span className={cx("cr-ok")}><DoneIcon />Available</span> : undefined} htmlFor={`${ids}-sym`} label="Ticker">
            <Field form={form} id={`${ids}-sym`} label="Ticker" maxLength={10} path="symbol" placeholder="e.g. MRDN" pre="$" size="lg" type="sym" />
          </CrField>
        </div>
      </div>
      <div className={cx("cr-grid")}>
        <CrField error={<CrErr message={form.shown("supply")} path="supply" />} help="Minted once when you publish. No one can mint more." helpId={`${ids}-supply-help`} htmlFor={`${ids}-supply`} label="Total supply">
          <Field describedBy={`${ids}-supply-help`} form={form} id={`${ids}-supply`} label="Total supply" max={createMaxSupply(draft.decimals) * 10} path="supply" suf={symOf(draft)} type="int" />
        </CrField>
        <CrField help={draft.burnable ? "Holders can burn their tokens, so the supply can only go down." : undefined} label="After launch">
          <CrSeg label="Supply after launch" onChange={(burnable) => edit({ burnable })} options={[[false, "Fixed"], [true, "Burn only"]]} value={draft.burnable} />
        </CrField>
      </div>
      <div className={cx("cr-disclosure-group")}>
        <DisclosureButton aria-controls={`${ids}-advanced`} aria-expanded={advanced.open} className={cx("cr-disclosure")} onClick={advanced.toggle}>
          <span>Advanced <span className={cx("cr-disclosure-note")}>· {draft.decimals} decimals</span></span>
        </DisclosureButton>
        <Collapse id={`${ids}-advanced`} open={advanced.open}>
          <div className={cx("cr-collapse-body")}>
            <CrField error={<CrErr message={form.shown("decimals")} path="decimals" />} label="Decimals">
              <CrSeg label="Coin decimals" onChange={(decimals) => edit({ decimals })} options={CREATE_DECIMALS.map((decimals) => [decimals, String(decimals)] as const)} value={draft.decimals} />
            </CrField>
          </div>
        </Collapse>
      </div>
    </Card>
    <div className={cx("cr-actions cr-sticky-action")}>
      <Button loading={form.state.phase === "loading"} loadingLabel="Loading your draft" onClick={() => goToStep("raise")} variant="primary">Continue to raise</Button>
    </div>
    </>
  );
}

// ---------- Details ----------

function inspectCoverHint(file: File, onHint: (hint: string | null) => void) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  let active = true;
  image.onload = () => { if (active) onHint(coverHint(image.naturalWidth, image.naturalHeight)); };
  image.onerror = () => { if (active) onHint(null); };
  image.src = url;
  return () => {
    active = false;
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  };
}

/**
 * R3-25: the cover (FEATURE-MAP-R3 §20), at the 3:1 it is stored and shown
 * at, with the centre safe area that phones keep when they crop it. The
 * picked file uploads at once; a picked image that is small or far from 3:1
 * gets a note that never blocks the upload. After a reload the note comes
 * from the size of the upload the stored cover was made from (`cover.source`;
 * none for covers stored before it was recorded).
 */
function CoverField({ form, onCover, onCoverRemove }: Readonly<{ form: Form; onCover?: (file: File) => void; onCoverRemove?: () => void }>) {
  const phone = usePhoneLayout();
  const cover = form.state.coverPreview ?? form.state.cover?.url ?? null;
  const [hint, setHint] = useState<string | null>(null);
  // Until a cover is picked or removed here, the note is the stored cover's.
  const [picked, setPicked] = useState(false);
  const source = form.state.cover?.source ?? null;
  const note = picked ? hint : source ? coverHint(source.width, source.height) : null;
  const inspection = useRef<(() => void) | null>(null);
  useEffect(() => () => inspection.current?.(), []);
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    inspection.current?.();
    inspection.current = null;
    setPicked(true);
    setHint(null);
    onCover?.(file);
    if (file.size <= SALE_COVER_MAX_BYTES) inspection.current = inspectCoverHint(file, setHint);
  };
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className={cx("cr-cover")}>
      <div className={cx("cr-cover-head")}>
        <span className={cx("cr-label")}>Cover</span>
        <span className={cx("cr-cover-actions")}>
          <Button aria-label={cover ? "Replace cover image" : "Upload cover image"} data-cr-upload="" onClick={() => fileInput.current?.click()} size="sm">
            {cover ? "Replace" : "Upload"}
          </Button>
          {cover ? (
            <Button disabled={!form.state.cover} onClick={() => { inspection.current?.(); inspection.current = null; setPicked(true); setHint(null); onCoverRemove?.(); }} size="sm">
              Remove
            </Button>
          ) : null}
        </span>
        <FileField accept="image/png,image/jpeg,image/webp" hidden onChange={pick} ref={fileInput} />
      </div>
      {phone ? <PhoneCoverGuide /> : null}
      <div className={cx("cr-cover-frame", cover && "has-cover")}>
        {/* eslint-disable-next-line @next/next/no-img-element -- the stored cover, or the picked file while it uploads */}
        {cover ? <img alt="Cover preview" height={512} src={cover} width={1_536} /> : null}
        <span aria-hidden="true" className={cx("cr-safe")} />
        <span aria-hidden="true" className={cx("cr-safe-label")}>Safe area</span>
      </div>
      {!phone ? <span className={cx("cr-cover-guide")}>
        <span><b>{`${COVER_GUIDE.width} × ${COVER_GUIDE.height} px`}</b>{` (3:1), at least ${COVER_GUIDE.minWidth} × ${COVER_GUIDE.minHeight} · JPG, PNG or WebP, up to ${SALE_COVER_MAX_BYTES / 1_000_000} MB`}</span>
        <span>Keep logos and text inside the safe area.</span>
      </span> : null}
      {cover && note ? <span className={cx("cr-cover-hint")} role="status">{note}</span> : null}
    </div>
  );
}

const LINK_PATHS = new Set(["site", "x_handle", "telegram", "docs_url", "audit_url"]);

/**
 * R3-25: the links (FEATURE-MAP-R3 §20): all optional, editable after
 * publishing, each checked in the gate's words. A pasted X or Telegram link,
 * or an `@`, is kept as the bare handle.
 */
function LinksField({ form }: Readonly<{ form: Form }>) {
  const ids = useId();
  const { draft } = form.state;
  const filled = [draft.site, draft.x_handle, draft.telegram, draft.docs_url, draft.audit_url].some((value) => value.trim());
  const disclosure = useDisclosure(form, (path) => LINK_PATHS.has(path), filled);
  const link = (path: string, label: string, input: ReactNode, className?: string) => (
    <CrField className={className} error={<CrErr message={form.shown(path)} path={path} />} htmlFor={`${ids}-${path}`} label={label}>
      {input}
    </CrField>
  );
  return (
    <div className={cx("cr-disclosure-group cr-g")} data-sec="links" id="cr-links" tabIndex={-1}>
      <DisclosureButton aria-controls={`${ids}-links`} aria-expanded={disclosure.open} className={cx("cr-disclosure")} onClick={disclosure.toggle}>
        <span>Links <span className={cx("cr-disclosure-note")}>· Optional</span></span>
      </DisclosureButton>
      <Collapse id={`${ids}-links`} open={disclosure.open}>
        <div className={cx("cr-collapse-body cr-grid")}>
          {link("site", "Website", <Field size="lg" form={form} id={`${ids}-site`} label="Website" maxLength={120} path="site" placeholder="meridian.finance" type="text" />)}
          {link("x_handle", "X", <Field size="lg" form={form} id={`${ids}-x_handle`} label="X handle" maxLength={120} normalize={bareXHandle} path="x_handle" placeholder="handle" pre="@" type="text" />)}
          {link("telegram", "Telegram", <Field size="lg" form={form} id={`${ids}-telegram`} label="Telegram" maxLength={120} normalize={bareTelegram} path="telegram" placeholder="meridianfx" pre="t.me/" type="text" />)}
          {link("docs_url", "Docs", <Field size="lg" form={form} id={`${ids}-docs_url`} label="Docs" maxLength={120} path="docs_url" placeholder="docs.meridian.finance" type="text" />)}
          {link("audit_url", "Audit report", <Field size="lg" form={form} id={`${ids}-audit_url`} label="Audit report" maxLength={160} path="audit_url" placeholder="Link to the PDF or page" type="text" />, "cr-span")}
        </div>
      </Collapse>
    </div>
  );
}

function DetailsStep({ form, onCover, onCoverRemove }: Readonly<{ form: Form; onCover?: (file: File) => void; onCoverRemove?: () => void }>) {
  const ids = useId();
  const { draft } = form.state;
  const bad = form.shown("tagline") !== "";
  return (
    <>
    <section aria-label="Cover and details" className={cx("card cr-card cr-details cr-g")} data-sec="details" id="cr-details" tabIndex={-1}>
      <CoverField form={form} onCover={onCover} onCoverRemove={onCoverRemove} />
      <div className={cx("cr-field")}>
        <label className={cx("cr-label")} htmlFor={`${ids}-tag`}>Short description</label>
        <TextArea
          aria-describedby={[bad ? "cr-error-tagline" : null, `${ids}-tag-help`].filter(Boolean).join(" ")}
          aria-invalid={bad || undefined}
          className={cx("cr-desc")}
          data-f="tagline"
          id={`${ids}-tag`}
          maxLength={CREATE_TAGLINE_MAX * 2}
          onBlur={() => createStore.touch("tagline")}
          onChange={(event) => {
            const line = event.currentTarget.value.replace(/[\r\n]+/g, " ");
            if ([...line].length <= CREATE_TAGLINE_MAX) {
              edit({ tagline: line });
            }
          }}
          onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
          placeholder="e.g. Onchain FX for stablecoins on Sui"
          rows={2}
          value={draft.tagline}
        />
        <span className={cx("cr-desc-foot")}>
          <span id={`${ids}-tag-help`}>Shown on cards and the presale page</span>
          <span>{[...draft.tagline].length} / {CREATE_TAGLINE_MAX}</span>
        </span>
        <CrErr message={form.shown("tagline")} path="tagline" />
      </div>
      <LinksField form={form} />
    </section>
    <div className={cx("cr-actions cr-sticky-action")}>
      <Button onClick={() => goToStep("raise")}>Back</Button>
      <Button loading={form.state.phase === "loading"} loadingLabel="Loading your draft" onClick={() => review(form.issues)} variant="primary">Continue to review</Button>
    </div>
    </>
  );
}

// ---------- Raise ----------

function TimingHelp({ whenFilled, atTarget, atEnd }: Readonly<{ whenFilled: boolean; atTarget: ReactNode; atEnd: ReactNode }>) {
  return (
    <span className={cx("cr-timing-help")}>
      <span aria-hidden={!whenFilled}>{atTarget}</span>
      <span aria-hidden={whenFilled}>{atEnd}</span>
    </span>
  );
}

function poolVenueHelp(state: CreateState): string {
  const cetus = venueAvailable(state, "cetus");
  const bluefin = venueAvailable(state, "bluefin");
  if (cetus && bluefin) return "";
  if (cetus) return "Cetus supports this coin. Bluefin availability could not be verified. Reload to try again.";
  if (!bluefin) return "DEX availability could not be verified for this coin. Reload to try again.";
  return state.cetusTiers === null
    ? "Bluefin supports this coin. Cetus availability could not be verified. Reload to try again."
    : `Bluefin supports this coin. Cetus does not support ${quoteSymbol(state.draft)} for new presales.`;
}

/** The target in dollars at the same price used to validate the minimum. */
function targetInDollars(state: CreateState): string {
  const price = Number(selectedRaiseQuoteUsd(state));
  if (quoteSymbol(state.draft) !== "SUI" || !(price > 0) || !(state.draft.target > 0)) return "";
  return `≈ ${usd(state.draft.target * price, 0)} today. `;
}

/** The target's unit: a `$` before it for USDC; the coin's mark and symbol after it for any other. */
function targetAffix(draft: CreateDraft): Readonly<{ pre: string } | { suf: ReactNode }> {
  const affix = quoteAffix(draft);
  return "pre" in affix ? affix : { suf: <span className={cx("cr-coin")}><QuoteMark size={24} symbol={affix.suf} />{quoteDisplaySymbol(affix.suf)}</span> };
}

function poolFeeHelp(tiers: readonly (readonly [number, number])[]): string {
  if (tiers.length === 0) return "No supported pool fee is available for this raise coin.";
  return "What traders pay on each swap.";
}

function RaiseCard({ form }: Readonly<{ form: Form }>) {
  const ids = useId();
  const { draft, nowMs } = form.state;
  // The contract fixes the window from the start: a scheduled one, else the publish.
  const closes = utc((draft.start_ms ?? nowMs) + draft.days * DAY);
  const venueHelp = poolVenueHelp(form.state);
  return (
    <Card id="raise" title="Raise">
      <div className={cx("cr-grid")}>
        <RaiseCoinField form={form} />
        <CrField error={<CrErr message={form.shown("venue")} path="venue" />} help={venueHelp || undefined} label="Pool">
          <CrSeg disabled={(venue) => !venueAvailable(form.state, venue)} label="Pool venue" onChange={(venue) => edit({ venue })} options={[["cetus", <DexIdentity key="cetus" venue="cetus" />], ["bluefin", <DexIdentity key="bluefin" venue="bluefin" />]]} value={draft.venue} />
        </CrField>
      </div>
      <div className={cx("cr-grid cr-grid-target")}>
        <CrField
          error={<CrErr message={form.shown("target")} path="target" />}
          help={<TimingHelp whenFilled={draft.launch_when_filled} atTarget={`${targetInDollars(form.state)}The sale closes when it reaches this.`} atEnd={`${targetInDollars(form.state)}It can go over: everyone gets the same share, the rest back.`} />}
          htmlFor={`${ids}-target`}
          label="Target"
        >
          <Field className="cr-target" form={form} id={`${ids}-target`} label="Target" path="target" precision={presaleTargetDecimals(draft.quote_type)} size="lg" type="money" {...targetAffix(draft)} />
        </CrField>
        <CrField help={<TimingHelp whenFilled={draft.launch_when_filled} atTarget={`Closes at the target or by ${closes}.`} atEnd={`Closes ${closes}.`} />} label="Runs for">
          <CrSeg label="Runs for" onChange={(days) => edit({ days })} options={saleDayOptions(draft.days).map((days) => [days, days === 1 ? "1 day" : `${days} days`] as const)} value={draft.days} />
        </CrField>
      </div>
    </Card>
  );
}

/** The raise's rarer settings, folded first under the Raise card: the pool fee and a scheduled start. */
function RaiseAdvancedCard({ form }: Readonly<{ form: Form }>) {
  const ids = useId();
  const { draft, nowMs } = form.state;
  const tiers = draft.venue === "cetus" ? cetusTiersForQuote(draft.quote_type, form.state.cetusTiers)
    : venueTiers("bluefin").filter(([spacing, fee]) => bluefinTierSupported(form.state.bluefinOptions, spacing, fee));
  const startError = form.shown("start_ms");
  const fold = useCardFold(form, (_section, path) => path === "pool_fee" || path === "start_ms");
  const opens = draft.start_ms === null ? "at publish" : <DateStamp at={draft.start_ms} plain />;
  return (
    <Card fold={fold} id="advanced" title="Advanced" value={<>{ppmPct(draft.pool_fee)} pool fee, opens {opens}</>}>
      <div className={cx("cr-grid")}>
        <CrField error={<CrErr message={form.shown("pool_fee")} path="pool_fee" />} help={poolFeeHelp(tiers)} htmlFor={`${ids}-fee`} label="Pool fee">
          <SelectField aria-describedby={form.shown("pool_fee") ? "cr-error-pool_fee" : undefined} aria-label="Pool fee" data-f="pool_fee" disabled={tiers.length === 0} id={`${ids}-fee`} onChange={(event) => edit({ pool_fee: Number(event.currentTarget.value) })} size="lg" value={draft.pool_fee}>
            {!tiers.some(([, fee]) => fee === draft.pool_fee) ? <option disabled value={draft.pool_fee}>{ppmPct(draft.pool_fee)} (unavailable)</option> : null}
            {tiers.map(([, fee]) => (
              <option key={fee} value={fee}>
                {ppmPct(fee)}
              </option>
            ))}
          </SelectField>
        </CrField>
        <CrField error={<CrErr message={startError} path="start_ms" />} help={draft.start_ms === null ? "Opens when you publish." : `Opens ${utc(draft.start_ms)}.`} helpId={`${ids}-opens-help`} htmlFor={`${ids}-opens`} label="Opens">
          <TextField
            aria-describedby={[`${ids}-opens-help`, startError ? "cr-error-start_ms" : null].filter(Boolean).join(" ")}
            aria-invalid={startError !== "" || undefined}
            data-f="start_ms"
            id={`${ids}-opens`}
            max={startFieldText(nowMs + CREATE_START_MAX_AHEAD_MS)}
            min={startFieldText(nowMs)}
            onBlur={() => createStore.touch("start_ms")}
            onChange={(event) => edit({ start_ms: parseStartField(event.currentTarget.value) })}
            size="lg"
            type="datetime-local"
            value={startFieldText(draft.start_ms)}
          />
        </CrField>
      </div>
    </Card>
  );
}

function ReachLine({ ok, children }: Readonly<{ ok: boolean; children: ReactNode }>) {
  return (
    <span className={cx("cr-check-line", ok ? "ok" : "todo")}>
      {ok ? <DoneIcon /> : <i />}
      <span>{children}</span>
    </span>
  );
}

function liftCapacityNote(draft: CreateDraft, capacity: number | null): string {
  if (capacity === null) return "";
  if (capacity < draft.target) return ` Below the ${presaleTargetDecimals(draft.quote_type) > 2 ? draftTarget(draft) : draftShort(draft, draft.target)} target at the minimum.`;
  return capacity > draft.target && (draft.launch_when_filled || draft.lift_hard_cap) ? " Above the target; the sale still stops at the target." : " Enough for the target.";
}

function LiftLimits({ form }: Readonly<{ form: Form }>) {
  const ids = useId();
  const { draft } = form.state;
  const open = draft.eligibility === "open";
  const anyone = draft.lift_access === "anyone";
  const { slots } = liftSlots(draft, allowlistForChecks(form.state));
  const liftReach = draft.lift && anyone && draft.lift_min > 0 && slots > 0 ? draft.lift_min * slots : null;
  const reachNote = liftCapacityNote(draft, liftReach);
  return (
    <div className={cx("cr-sub cr-lift")}>
      <div className={cx("cr-grid")}>
        <CrField label="Starts">
          <CrSeg label="When limits lift" onChange={(lift_hours) => edit({ lift_hours })} options={CREATE_LIFT_HOURS.map((hours) => [hours, LIFT_LABELS[hours]!] as const)} value={draft.lift_hours} />
        </CrField>
        <CrField help={anyone ? "Any wallet, no per-wallet maximum." : "Wallets that could already join, no per-wallet maximum."} label="Open to">
          <CrSeg label="Who can join once limits lift" onChange={(lift_access) => edit({ lift_access })} options={[["eligible", open ? "Same wallets" : "Allowlist"], ["anyone", "Anyone"]]} value={draft.lift_access} />
        </CrField>
      </div>
      {anyone ? (
        <>
          <div className={cx("cr-grid")}>
            <CrField error={<CrErr message={form.shown("lift_max_wallets")} path="lift_max_wallets" />} help="Counting everyone who joined before." htmlFor={`${ids}-lift-wallets`} label="Maximum participating wallets">
              <Field form={form} id={`${ids}-lift-wallets`} label="Maximum participating wallets once limits lift" max={CREATE_MAX_WALLETS * 10} path="lift_max_wallets" type="int" />
            </CrField>
            <CrField error={<CrErr message={form.shown("lift_min")} path="lift_min" />} htmlFor={`${ids}-lift-min`} label="Minimum contribution per wallet">
              <Field form={form} id={`${ids}-lift-min`} label="Minimum contribution per new wallet" path="lift_min" type="money" {...quoteAffix(draft)} />
            </CrField>
          </div>
          {liftReach !== null ? (
            <ReachLine ok={liftReach >= draft.target}>
              <span className={cx("cr-capacity")}><span>Minimum-contribution capacity: <strong>{draftMoney(draft, liftReach, Number.isInteger(liftReach) ? 0 : 2)}</strong></span><span>{slots.toLocaleString("en-US")} open slots · {reachNote.trim()}</span></span>
            </ReachLine>
          ) : null}
        </>
      ) : null}
      {draft.launch_when_filled ? null : (
        <div className={cx("cr-toggle-row plain")}>
          <span className={cx("cr-toggle-text")}>
            <b>Stop at the target</b>
            <span>{draft.lift_hard_cap ? "Takes only what is left of the target; launches at the scheduled end." : "It can go over the target; everyone gets the same share."}</span>
          </span>
          <CrSwitch checked={draft.lift_hard_cap} label="Stop at the target" onChange={(lift_hard_cap) => edit({ lift_hard_cap })} />
        </div>
      )}
    </div>
  );
}

/** "Anyone, 30,000 max", "Allowlist, 120 wallets": who can join, in a few words. */
function joinValue(draft: CreateDraft, listed: number | null): string {
  if (draft.eligibility !== "open") return listed === null ? "Allowlist, no list yet" : `Allowlist, ${listed.toLocaleString("en-US")} wallets`;
  return draft.max_wallets > 0 ? `Anyone, ${draft.max_wallets.toLocaleString("en-US")} max` : "Anyone";
}

function JoinCard({ form, onList, allowlistActions }: Readonly<{ form: Form; onList: (file: File) => void; allowlistActions?: AllowlistActions }>) {
  const ids = useId();
  const { draft } = form.state;
  const open = draft.eligibility === "open";
  const allowlist = allowlistForChecks(form.state);
  const reach = open && draft.min_commitment > 0 && draft.max_wallets > 0 ? draft.min_commitment * draft.max_wallets : null;
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) onList(file);
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const liftId = useId();
  const fold = useCardFold(form, (section) => section === "join");
  return (
    <Card fold={fold} id="join" title="Who can join" value={joinValue(draft, allowlist?.leaf_count ?? null)}>
      <div className={cx("cr-grid")}>
        <CrField help={open ? undefined : "Only the wallets on your list, each with its own limit."} label="Access">
          <CrSeg label="Who can join" onChange={(eligibility) => edit({ eligibility })} options={[["open", "Anyone"], ["allowlist", "Allowlist"]]} value={draft.eligibility} />
        </CrField>
        {open ? (
          <CrField error={<CrErr message={form.shown("max_wallets")} path="max_wallets" />} htmlFor={`${ids}-wallets`} label="Maximum participating wallets">
            <Field form={form} id={`${ids}-wallets`} label="Maximum participating wallets" max={CREATE_MAX_WALLETS * 10} path="max_wallets" type="int" />
          </CrField>
        ) : null}
      </div>
      {open ? (
        <>
          <div className={cx("cr-grid")}>
            <CrField error={<CrErr message={form.shown("wallet_cap")} path="wallet_cap" />} htmlFor={`${ids}-cap`} label="Maximum contribution per wallet">
              <Field form={form} id={`${ids}-cap`} label="Maximum contribution per wallet" path="wallet_cap" type="money" {...quoteAffix(draft)} />
            </CrField>
            <CrField error={<CrErr message={form.shown("min_commitment")} path="min_commitment" />} htmlFor={`${ids}-min`} label="Minimum contribution per wallet">
              <Field form={form} id={`${ids}-min`} label="Minimum contribution per wallet" path="min_commitment" type="money" {...quoteAffix(draft)} />
            </CrField>
          </div>
          {reach !== null ? (
            <ReachLine ok={reach >= draft.target}>
              At the minimum, {draft.max_wallets.toLocaleString("en-US")} wallets raise {draftMoney(draft, reach)}
              {reach >= draft.target ? ", enough for the target" : `, short of the ${draftTarget(draft)} target`}
            </ReachLine>
          ) : null}
        </>
      ) : (
        <AllowlistCard actions={allowlistActions} busy={form.state.allowlistUploading} count={allowlist?.leaf_count ?? null} error={form.shown("allowlist")} input={<FileField accept=".csv,text/csv,text/plain" hidden onChange={pick} ref={fileInput} />} onUpload={() => fileInput.current?.click()} symbol={allowlist && !allowlistFitsQuote(allowlist.quote_type, draft.quote_type) ? quoteDisplaySymbol(draftQuote({ quote_type: allowlist.quote_type }).symbol) : quoteSymbol(draft)} />
      )}
      <div className={cx("cr-toggle-row")}>
        <span className={cx("cr-toggle-text")}><b>Lift limits near the end</b></span>
        <CrSwitch checked={draft.lift} controls={liftId} label="Lift limits near the end" onChange={(lift) => edit({ lift })} />
      </div>
      <Collapse focusOnClose={() => document.querySelector<HTMLButtonElement>('[aria-label="Lift limits near the end"]')} id={liftId} keepMounted={false} open={draft.lift}>
        <LiftLimits form={form} />
      </Collapse>
    </Card>
  );
}

/** The launch figures: the presale price, the pool's opening price and premium, the value at launch, the liquidity. */
export function LaunchFacts({ draft, fees }: Readonly<{ draft: CreateDraft; fees: CreateState["fees"] }>) {
  const terms = draftTerms(draft, fees);
  // The Summary states the prices and the value at launch; this card keeps only the pool's make-up.
  return (
    <dl className={cx("cr-kv")}>
      <div>
        <dt>Liquidity</dt>
        <dd className="num">
          {tokens(terms.poolTokens)} {symOf(draft)} + {draftMoney(draft, terms.poolQuote)}
        </dd>
      </div>
    </dl>
  );
}

function LaunchCard({ form }: Readonly<{ form: Form }>) {
  const { draft, fees } = form.state;
  const fold = useCardFold(form, (section) => section === "launch");
  return (
    <Card fold={fold} id="launch" title="Launch" value={`${draft.launch_when_filled ? "At target" : "At scheduled end"}, ${draft.lp_days}-day window`}>
      <div className={cx("cr-grid")}>
        <CrField help={<TimingHelp whenFilled={draft.launch_when_filled} atTarget="Stops at the target; the pool can launch once it fills." atEnd="Launches at the scheduled end, even if it fills earlier." />} label="Launch timing">
          <CrSeg label="Launch timing" onChange={(launch_when_filled) => edit({ launch_when_filled })} options={[[true, "When target is reached"], [false, "At scheduled end"]]} value={draft.launch_when_filled} />
        </CrField>
        <CrField help="Launch the pool within this, or anyone can cancel and refund everyone." label="Launch window">
          <CrSeg label="Launch window" onChange={(lp_days) => edit({ lp_days })} options={CREATE_LP_DAYS.map((days) => [days, `${days} days`] as const)} value={draft.lp_days} />
        </CrField>
      </div>
      <LaunchFacts draft={draft} fees={fees} />
    </Card>
  );
}

/** A share set by Blast: grey, with a lock that names it. */
function Locked({ text }: Readonly<{ text: string }>) {
  return (
    <span className={cx("cr-tile-value locked")}>
      {text}
      <span aria-label="Locked, set by Blast" className={cx("cr-lock")} role="img"><LockIcon /></span>
    </span>
  );
}

function Tile({ color, label, value, sub, locked }: Readonly<{ color: string; label: string; value: ReactNode; sub: ReactNode; locked?: boolean }>) {
  return (
    <div className={cx("cr-tile", locked && "locked")}>
      <span className={cx("cr-tile-label")}><span aria-hidden="true" className={cx("dot cr-color")} data-cr-color={color} />{label}</span>
      {value}
      <span className={cx("cr-tile-sub")}>{sub}</span>
    </div>
  );
}

const vestSummary = (row: CreateBuyerVesting, from: string) =>
  row.duration > 0 ? `Vests ${row.duration} ${VESTING_UNIT_LABEL[row.duration_unit]}${row.cliff ? `, ${row.cliff}-${VESTING_UNIT_LABEL[row.cliff_unit]} cliff` : ""} · ${from}` : "";

/**
 * Stable keys for a list of recipient rows, which carry no id of their own: one
 * per row, kept through a removal (`drop`, by index), a new one for each row
 * added at the end, so removing a row never hands its neighbour's inputs to it.
 */
function useRowKeys(count: number): Readonly<{ keys: readonly number[]; drop: (index: number) => void }> {
  const [state, setState] = useState(() => ({ keys: Array.from({ length: count }, (_, at) => at), next: count }));
  let current = state;
  if (state.keys.length !== count) {
    const grow = count - state.keys.length;
    current = grow > 0
      ? { keys: [...state.keys, ...Array.from({ length: grow }, (_, at) => state.next + at)], next: state.next + grow }
      : { keys: state.keys.slice(0, count), next: state.next };
    setState(current);
  }
  return { keys: current.keys, drop: (index) => setState((was) => ({ keys: was.keys.filter((_, at) => at !== index), next: was.next })) };
}

/** A recipient's vesting: the same switch as the buyers'; its "Vesting" label shows where the column header does not. */
function RecipientVesting({ form, path, row, scope }: Readonly<{ form: Form; path: string; row: CreateRecipient; scope: string }>) {
  return (
    <span className={cx("cr-vest-t")}>
      <span aria-hidden="true" className={cx("cr-vest-name")}>Vesting</span>
      <CrSwitch checked={row.vest} describedBy={form.shown(path) ? `cr-error-${path}` : undefined} label={`${scope}: Vesting for ${row.label || "recipient"}`} onChange={(vest) => createStore.edit((draft) => setPath(draft, path, vest))} path={path} />
    </span>
  );
}

function VestingFields({ form, path, row, scope, fromClaim = false }: Readonly<{ form: Form; path: string; row: CreateBuyerVesting; scope: string; fromClaim?: boolean }>) {
  const vestId = useId();
  const from = fromClaim ? "counts from each buyer’s claim" : "counts from launch";
  return (
    <div className={cx("cr-vest")}>
      <div className={cx("cr-grid")}>
        {(["cliff", "duration"] as const).map((field) => {
          const unitField = `${field}_unit` as const;
          const unit = row[unitField];
          const label = field === "duration" ? "Fully vested after" : "Cliff";
          const accessible = `${scope} ${field === "duration" ? "vesting length" : "cliff"}`;
          return (
            <CrField htmlFor={`${vestId}-${field}`} key={field} label={label}>
              <div className={cx("cr-unit")}>
                <Field className="cr-xs" form={form} id={`${vestId}-${field}`} label={`${accessible}, in ${unit}`} path={`${path}.${field}`} type="int" />
                <SelectField aria-label={`${accessible} unit`} className={cx("cr-unit-select")} size="lg" data-f={`${path}.${unitField}`} onChange={(event) => createStore.edit((draft) => setPath(draft, `${path}.${unitField}`, event.currentTarget.value))} value={unit}>
                  {vestingUnitOptions(unit).map((option) => <option key={option} value={option}>{option}</option>)}
                </SelectField>
              </div>
            </CrField>
          );
        })}
      </div>
      <span className={cx("cr-vsum")}>
        {fromClaim
          ? `Unlocks evenly over ${row.duration} ${VESTING_UNIT_LABEL[row.duration_unit]} from each buyer’s claim${row.cliff ? `; none before the ${row.cliff}-${VESTING_UNIT_LABEL[row.cliff_unit]} cliff` : ""}.`
          : vestSummary(row, from)}
      </span>
      <CrErr message={form.shown(`${path}.vest`)} path={`${path}.vest`} />
    </div>
  );
}

/** "6 mo, 1-mo cliff", "Off": the buyers' schedule in a few words. */
function vestingValue(row: CreateBuyerVesting): string {
  if (!row.vest) return "Off";
  if (!(row.duration > 0)) return "On, not set";
  return `${row.duration} ${VESTING_UNIT_LABEL[row.duration_unit]}${row.cliff ? `, ${row.cliff}-${VESTING_UNIT_LABEL[row.cliff_unit]} cliff` : ""}`;
}

function VestingCard({ form }: Readonly<{ form: Form }>) {
  const fold = useCardFold(form, (_, path) => inBuyerVesting(path));
  return (
    <Card fold={fold} id="vesting" title="Buyer vesting" value={vestingValue(form.state.draft.buyer_vesting)}>
      <BuyerVesting form={form} />
    </Card>
  );
}

function BuyerVesting({ form }: Readonly<{ form: Form }>) {
  const row = form.state.draft.buyer_vesting;
  const disclosureId = useId();
  return (
    <div className={cx("cr-buyer-vesting")}>
      <div className={cx("cr-toggle-row plain")}>
        {/* The card's title names it; the switch keeps its own accessible name. */}
        <span className={cx("cr-toggle-text")}>
          <span>{row.vest ? "Starts at each buyer’s first claim; rewards go straight to them." : "Buyers get everything at claim."}</span>
        </span>
        <CrSwitch checked={row.vest} controls={disclosureId} describedBy={form.shown("buyer_vesting.vest") ? "cr-error-buyer_vesting.vest" : undefined} label="Presale buyers vesting" onChange={(vest) => createStore.edit((draft) => setPath(draft, "buyer_vesting.vest", vest))} path="buyer_vesting.vest" />
      </div>
      <Collapse className={cx("cr-buyer-schedule")} id={disclosureId} open={row.vest}>
        <VestingFields form={form} fromClaim path="buyer_vesting" row={row} scope="Presale buyers" />
      </Collapse>
    </div>
  );
}

type RecipientList = "token_recipients" | "raise_recipients" | "fee_recipients";

function totalFeeShare(bps: number, form: Form): string {
  const { fees, draft } = form.state;
  const token = pctText(bps * (10_000 - fees.lp_fee_meme_bps) / 10_000);
  const quote = pctText(bps * (10_000 - fees.lp_fee_quote_bps) / 10_000);
  return token === quote ? token : `${token} token / ${quote} ${quoteSymbol(draft)}`;
}

function Recipients({ form, list, lead, colors }: Readonly<{ form: Form; list: RecipientList; lead?: ReactNode; colors: readonly string[] }>) {
  const rows = form.state.draft[list] as readonly (CreateRecipient | CreateFeeRecipient)[];
  const rowKeys = useRowKeys(rows.length);
  const fees = list === "fee_recipients";
  const remove = (index: number) => {
    rowKeys.drop(index);
    createStore.edit((draft) => ({ ...draft, [list]: (draft[list] as readonly unknown[]).filter((_, at) => at !== index) }) as CreateDraft);
    createStore.set((current) => ({ touched: new Set([...current.touched].filter((path) => !path.startsWith(`${list}.`))) }));
  };
  const keyed = rows.map((row, at) => ({ row, rowKey: rowKeys.keys[at] ?? (-1 - at) }));
  if (!rows.length && !lead) return null;
  const scope = list === "token_recipients" ? "Token split" : list === "raise_recipients" ? "Raise split" : "Trading fees";
  return (
    <div className={cx("cr-recs", fees && "fees")}>
      <div aria-hidden="true" className={cx("cr-columns")}>
        <span />
        <span>Recipient</span>
        <span>Wallet</span>
        <span>Share</span>
        <span>{fees ? "Of total trading fees" : "Vesting"}</span>
      </div>
      {lead}
      {keyed.map(({ row, rowKey }, index) => {
        const self = "self" in row && row.self;
        const name = self ? "Your" : `${row.label || "Recipient"}'s`;
        return (
          <div className={cx("cr-rec-group")} key={rowKey}>
            <div className={cx("cr-rec")} data-rec={`${list}.${index}`}>
              <span aria-hidden="true" className={cx("dot cr-color")} data-cr-color={colors[index]} />
              {self ? (
                <>
                  <b className={cx("cr-me")}>You</b>
                  <span className={cx("cr-wallet")} title={form.state.selfAddress ?? undefined}>{form.state.selfAddress ? shortAddress(form.state.selfAddress, 10, 8) : "Your wallet"}</span>
                </>
              ) : (
                <>
                  <Field className="cr-lbl" form={form} label={`${scope}: recipient name`} maxLength={20} path={`${list}.${index}.label`} placeholder="Name" size="md" type="text" />
                  <Field className="cr-addr" form={form} label={`${scope}: ${walletLabel(row.label || "Recipient")}`} path={`${list}.${index}.address`} size="md" type="addr" />
                </>
              )}
              <Field className="cr-pct" form={form} label={`${scope}: ${name} share`} path={`${list}.${index}.bps`} size="md" suf="%" type="pct" />
              {fees ? <span className={cx("cr-fee-total")}>{totalFeeShare(row.bps, form)}</span> : null}
              {!fees && "vest" in row ? <RecipientVesting form={form} path={`${list}.${index}.vest`} row={row} scope={scope} /> : null}
              {self ? null : (
                <IconButton aria-label={`Remove ${row.label || "recipient"}`} className={cx("cr-x")} onClick={() => remove(index)} title="Remove">
                  <CloseIcon strokeWidth="2" />
                </IconButton>
              )}
              <span className={cx("cr-errs")}>
                <CrErr message={form.shown(`${list}.${index}.bps`)} path={`${list}.${index}.bps`} />
              </span>
            </div>
            {!fees && "vest" in row && row.vest ? (
              <VestingFields form={form} path={`${list}.${index}`} row={row} scope={`${scope}: ${row.label || "Recipient"}`} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function AddRecipient({ form, list, max }: Readonly<{ form: Form; list: RecipientList; max: number }>) {
  const count = form.state.draft[list].length;
  const add = () => {
    createStore.edit((draft) => ({ ...draft, [list]: [...draft[list], list === "fee_recipients" ? emptyFeeRecipient() : emptyRecipient()] }) as CreateDraft);
    focusNextFrame(() => document.querySelector<HTMLInputElement>(`#cr [data-f="${list}.${count}.label"]`), { preventScroll: true });
  };
  return (
    <div className={cx("cr-add")}>
      <Button disabled={count >= max} onClick={add} size="sm">Add recipient</Button>
      <span>Up to {max} recipients</span>
    </div>
  );
}

function SplitCard({ form }: Readonly<{ form: Form }>) {
  const { draft, fees } = form.state;
  const terms = draftTerms(draft, fees);
  const total = draft.buyers_bps + draft.pool_bps + fees.token_bps + sumBps(draft.token_recipients);
  const shades = splitShades([draft.buyers_bps, draft.pool_bps, ...draft.token_recipients.map((row) => row.bps), fees.token_bps]);
  const blast = shades.at(-1)!;
  const fold = useCardFold(form, (section, path) => section === "split" && !inBuyerVesting(path));
  return (
    <Card aside={`${tokens(draft.supply)} ${symOf(draft)}`} fold={fold} id="split" title="Token split" value={`Buyers ${pctText(draft.buyers_bps)}, pool ${pctText(draft.pool_bps)}${recipientsNote(draft.token_recipients.length)}`}>
      <SplitSummary
        bps={total}
        parts={[
          [draft.buyers_bps, shades[0]!, "Presale buyers"],
          [draft.pool_bps, shades[1]!, "Liquidity pool"],
          ...draft.token_recipients.map((row, index) => [row.bps, shades[2 + index]!, row.label || "Recipient"] as const),
          [fees.token_bps, blast, "Blast"],
        ]}
      />
      <div className={cx("cr-tiles")}>
        <Tile color={shades[0]!} label="Presale buyers" sub={`${tokens(terms.buyersTokens)} ${symOf(draft)}`} value={<Field className="cr-pct" form={form} label="Presale buyers share" path="buyers_bps" size="md" suf="%" type="pct" />} />
        <Tile color={shades[1]!} label="Liquidity pool" sub={`${tokens(terms.poolTokens)} ${symOf(draft)} · locked forever`} value={<Field className="cr-pct" form={form} label="Liquidity pool share" path="pool_bps" size="md" suf="%" type="pct" />} />
        <Tile color={blast} label="Blast" locked sub="Paid only if the sale succeeds" value={<Locked text={pctText(fees.token_bps)} />} />
      </div>
      <Recipients colors={shades.slice(2)} form={form} list="token_recipients" />
      <AddRecipient form={form} list="token_recipients" max={CREATE_MAX_RECIPIENTS} />
    </Card>
  );
}

function RaiseSplitCard({ form }: Readonly<{ form: Form }>) {
  const { draft, fees } = form.state;
  const terms = draftTerms(draft, fees);
  const shades = splitShades([terms.lpBps, ...draft.raise_recipients.map((row) => row.bps), fees.raise_bps]);
  const blast = shades.at(-1)!;
  const fold = useCardFold(form, (section) => section === "rsplit");
  return (
    <Card aside={`${draftTarget(draft)} target`} fold={fold} id="rsplit" title="Raise split" value={`Pool ${pctText(Math.max(0, terms.lpBps))}, Blast ${pctText(fees.raise_bps)}${recipientsNote(draft.raise_recipients.length)}`}>
      <SplitSummary
        bps={10_000}
        error={terms.lpBps > 0 ? undefined : "No share left for the pool"}
        parts={[
          [terms.lpBps, shades[0]!, "Liquidity pool"],
          ...draft.raise_recipients.map((row, index) => [row.bps, shades[1 + index]!, row.label || "Recipient"] as const),
          [fees.raise_bps, blast, "Blast"],
        ]}
      />
      <div className={cx("cr-tiles")}>
        <Tile color={shades[0]!} label="Liquidity pool" locked sub="Paired with the pool’s tokens" value={<span className={cx("cr-tile-value")} title="What is left after the shares below">{pctText(Math.max(0, terms.lpBps))}</span>} />
        <Tile color={blast} label="Blast" locked sub="Paid only if the sale succeeds" value={<Locked text={pctText(fees.raise_bps)} />} />
      </div>
      <Recipients colors={shades.slice(1)} form={form} list="raise_recipients" />
      <AddRecipient form={form} list="raise_recipients" max={CREATE_MAX_RECIPIENTS} />
      <p className={cx("cr-note")}>Shares are of the target. Anything above it goes back to buyers.</p>
    </Card>
  );
}

function FeesCard({ form }: Readonly<{ form: Form }>) {
  const { draft, fees } = form.state;
  const equal = fees.lp_fee_meme_bps === fees.lp_fee_quote_bps;
  const feeBasis = equal
    ? "Trading fees"
    : `Token / ${quoteSymbol(draft)} fees`;
  const remaining = equal
    ? pctText(10_000 - fees.lp_fee_quote_bps)
    : `${pctText(10_000 - fees.lp_fee_meme_bps)} of token fees / ${pctText(10_000 - fees.lp_fee_quote_bps)} of ${quoteSymbol(draft)} fees`;
  const shades = splitShades([draft.holders_bps, ...draft.fee_recipients.map((row) => row.bps)]);
  const holders = (
    <div className={cx("cr-rec")}>
      <span aria-hidden="true" className={cx("dot cr-color")} data-cr-color={shades[0]} />
      <b className={cx("cr-me")}>Holders</b>
      <span className={cx("cr-wallet")}>Daily rewards to every holder</span>
      <Field className="cr-pct" form={form} label="Holders share of remaining fees" path="holders_bps" size="md" suf="%" type="pct" />
      <span className={cx("cr-fee-total")}>{totalFeeShare(draft.holders_bps, form)}</span>
    </div>
  );
  const fold = useCardFold(form, (section) => section === "fees");
  const self = draft.fee_recipients.find((row) => row.self);
  const others = draft.fee_recipients.length - (self ? 1 : 0);
  return (
    <Card fold={fold} id="fees" title="Trading fees" value={`Holders ${pctText(draft.holders_bps)}${self ? `, you ${pctText(self.bps)}` : ""}${recipientsNote(others)}`}>
      <div className={cx("cr-fee-box")}>
        <span className={cx("cr-fee-box-text")}>
          <span className={cx("cr-tile-label")}><span aria-hidden="true" className={cx("dot cr-color")} data-cr-color="var(--faint)" />Blast fee</span>
          <span className={cx("cr-tile-sub")}>{feeBasis}</span>
        </span>
        <Locked text={equal ? pctText(fees.lp_fee_quote_bps) : `${pctText(fees.lp_fee_meme_bps)} / ${pctText(fees.lp_fee_quote_bps)}`} />
      </div>
      <p className={cx("cr-fee-basis")}><b>Split of the remaining {remaining}</b><span>100% below = this remainder</span></p>
      <SplitSummary bps={draft.holders_bps + sumBps(draft.fee_recipients)} parts={[[draft.holders_bps, shades[0]!, "Holders"], ...draft.fee_recipients.map((row, index) => [row.bps, shades[1 + index]!, row.self ? "You" : row.label || "Recipient"] as const)]} />
      <Recipients colors={shades.slice(1)} form={form} lead={holders} list="fee_recipients" />
      <AddRecipient form={form} list="fee_recipients" max={CREATE_MAX_FEE_RECIPIENTS} />
      <p className={cx("cr-note")}>Fee shares never vest. They pay out for as long as the pool trades.</p>
    </Card>
  );
}

/**
 * The Create form (the CreateToken, CreateRaise and Create boards): the
 * current step's cards, every figure updating as it is typed, each field's
 * error shown once it is left (or all of them once Review was pressed), and
 * focus moving to the named field when the creator follows an issue (the
 * page opens that field's step first).
 */
export function CreateForm({
  state,
  issues,
  onLogo,
  onCover,
  onCoverRemove,
  onList,
  allowlistActions,
}: Readonly<{
  state: CreateState;
  issues: readonly CreateIssue[];
  onLogo: (file: File) => void;
  onCover?: (file: File) => void;
  onCoverRemove?: () => void;
  onList: (file: File) => void;
  allowlistActions?: AllowlistActions;
}>) {
  const run = useShellActions();
  const region = useRef<HTMLFieldSetElement>(null);
  useFeedbackReveal(state.phase, region);
  const blockUpload = (event: { target: EventTarget; preventDefault(): void; stopPropagation(): void }) => {
    if (state.phase === "ready" || !(event.target instanceof Element) || !event.target.closest("[data-cr-upload]")) return false;
    event.preventDefault();
    event.stopPropagation();
    if (state.phase === "visitor") run("openSignIn");
    return true;
  };
  const form = useMemo<Form>(() => {
    const bad = new Map(issues.map((issue) => [issue.path, issue.message]));
    return {
      state,
      issues,
      shown: (path) => (state.tried || state.touched.has(path) || (path.endsWith(".vest") && bad.has(path)) ? (bad.get(path) ?? "") : ""),
    };
  }, [state, issues]);

  const showRaise = state.step === "raise";
  // The page has opened the field's step (and its disclosure); focus it and bring it into view.
  const flash = state.flash;
  useEffect(() => {
    if (!flash) return;
    const section = document.getElementById(`cr-${flash.section}`);
    const issueFields: Readonly<Record<string, string>> = { reach: "max_wallets", lift_reach: "lift_min", split_total: "buyers_bps", rsplit_total: "raise_recipients.0.bps", fee_total: "holders_bps" };
    const path = issueFields[flash.path] ?? flash.path;
    const field = (path === "venue" ? region.current?.querySelector<HTMLElement>('[aria-label="Pool venue"] button:not(:disabled)') : document.querySelector<HTMLElement>(`#cr [data-f="${path}"]`)) ?? section?.querySelector<HTMLElement>("[aria-invalid=true], input, button");
    field?.focus({ preventScroll: true });
    (field ?? section)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  }, [flash]);

  return (
    <fieldset
      aria-busy={state.phase === "loading" || undefined}
      aria-label="Presale draft"
      ref={region}
      className={cx("cr cr-fields")}
      disabled={state.phase === "loading" || state.publishLocked}
      inert={state.phase === "loading" || state.publishLocked}
      hidden={state.step === "review"}
      id="cr"
      onClickCapture={(event) => { if (!blockUpload(event)) event.currentTarget.toggleAttribute("data-pointer-reveal", event.detail > 0); }}
      onKeyDownCapture={(event) => { event.currentTarget.removeAttribute("data-pointer-reveal"); if (event.key === "Enter" || event.key === " ") blockUpload(event); }}
    >
      {state.step === "token" ? <TokenStep form={form} onLogo={onLogo} /> : null}
      <AllocationStep active={showRaise} key={`${state.ownerId}:${state.draftId}`}>
        {showRaise ? <RaiseCard form={form} /> : null}
        <FoldList>
          {showRaise ? <>
            <RaiseAdvancedCard form={form} />
            <JoinCard allowlistActions={allowlistActions} form={form} onList={onList} />
            <LaunchCard form={form} />
            <VestingCard form={form} />
          </> : null}
          <SplitCard form={form} />
          <RaiseSplitCard form={form} />
          <FeesCard form={form} />
        </FoldList>
      </AllocationStep>
      {state.step === "details" ? <DetailsStep form={form} onCover={onCover} onCoverRemove={onCoverRemove} /> : null}
    </fieldset>
  );
}

function RaiseCoinField({ form }: Readonly<{ form: Form }>) {
  const { draft } = form.state;
  const quotes = availablePickerQuotes(form.state);
  const quoteProblem = quoteUnavailableReason(form.state, draft.quote_type);
  return (
    <CrField
      error={<CrErr message={form.shown("quote_type")} path="quote_type" />}
      help={quotes.length === 0 ? `${quoteProblem} Reload to try again. Your draft is kept.` : quoteProblem ? "Choose an available raise coin. Amounts stay unchanged until you choose." : quoteRowHelp(quoteSymbol(draft))}
      label="Raised in"
    >
      {quotes.length === 1 && !quoteProblem ? (
        <span aria-label={`Raised in ${quoteSymbol(draft)}`} className={cx("cr-quote")}><QuoteMark symbol={quoteSymbol(draft)} />{quoteSymbol(draft)}</span>
      ) : (
        <DisclosureButton
          aria-haspopup="dialog"
          aria-label={quoteProblem ? "Choose an available raise coin" : `Raised in ${quoteSymbol(draft)}. Change`}
          className={cx("cr-quote")}
          data-cr-quote=""
          data-f="quote_type"
          disabled={quotes.length === 0}
          onClick={() => createStore.set({ quoteOpen: true })}
        >
          <QuoteMark symbol={quoteSymbol(draft)} />
          {quoteProblem ? "Choose a coin" : quoteSymbol(draft)}
        </DisclosureButton>
      )}
    </CrField>
  );
}
