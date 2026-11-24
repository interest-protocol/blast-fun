"use client";

import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { useId, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";

import type { CreateDraft } from "@blast/core/web/contracts/create.ts";
import { SALE_COVER_MAX_BYTES } from "@blast/core/web/contracts/sales.ts";
import { pctText } from "@blast/core/modules/social/create/model.ts";
import { SplitBar } from "#web/components/blast-ui/SplitBar.tsx";
import { DisclosureButton, DisclosureSummary, type ControlSize } from "#web/components/blast-ui/Button.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { Ticker } from "#web/components/blast-ui/Ticker.tsx";

import { CheckIcon, ImageIcon } from "./create-icons";
import { cx } from "./cx";
import { COVER_GUIDE, fieldText, nameHue, parseField, type FieldType } from "./create-field-model";
import { signLabelText, type SignLabel } from "./create-review-model";
import { decimalText, dropDecimal, pasteDecimal } from "#web/lib/decimal-input.ts";
import { SUI_ADDRESS_PLACEHOLDER, SUI_NAME_LOOKUP_LABEL, useSuiAddressLookup } from "#web/lib/sui-address-input.ts";

/**
 * The Create form's building blocks: a labelled field (`CrField`), the input
 * (`CrIn`, the design's `crIn`), its error line, the segmented choice, the
 * switch, the coin's mark, the split bar and its total, and the vesting
 * diagram.
 */

export function MobilePreview({ children }: Readonly<{ children: ReactNode }>) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return <>
    <DisclosureButton
      aria-controls={id}
      aria-expanded={open}
      className={cx("cr-preview-toggle")}
      onClick={() => setOpen(!open)}
      variant="ghost"
    >Preview</DisclosureButton>
    <div className={cx("cr-preview-body")} data-open={open || undefined} id={id}>
      {children}
    </div>
  </>;
}

export function PhoneCoverGuide() {
  const { width, height, minWidth, minHeight } = COVER_GUIDE;
  return <div className={cx("cr-cover-guide")}>
    <span>{`JPG, PNG or WebP, up to ${SALE_COVER_MAX_BYTES / 1_000_000} MB · at least ${minWidth} × ${minHeight} px`}</span>
    <details>
      <DisclosureSummary>Cover recommendations</DisclosureSummary>
      <span>{`${width} × ${height} px (3:1). Keep logos and text inside the safe area.`}</span>
    </details>
  </div>;
}

export type CrInProps = Readonly<{
  path: string;
  type: FieldType;
  value: string | number;
  onValue: (value: string | number) => void;
  onLeave: (path: string) => void;
  bad: boolean;
  addressError?: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
  max?: number;
  precision?: number;
  pre?: ReactNode;
  suf?: ReactNode;
  className?: string;
  /** The input's id, for a visible `<label htmlFor>` naming it. */
  id?: string;
  size?: ControlSize;
  /** The id of help text under the field, read with the field. */
  describedBy?: string;
}>;

function fieldTypingAttributes(textual: boolean, placeholder?: string) {
  return textual
    ? { placeholder, spellCheck: false }
    : { inputMode: "decimal" as const, placeholder: placeholder ?? "0" };
}

/**
 * One field (`.cr-in`, the shared `FieldGroup` and `TextField`, so its edge
 * and focus ring stay inside the field): free typing, the figure reformatted when the field is
 * left (as the design does on focusout), a zero figure left empty under a "0" placeholder, the
 * ticker upper-cased as it is typed with the caret kept, or a wallet address.
 */
export function CrIn(props: CrInProps) {
  return props.type === "addr" ? <CrAddressIn {...props} /> : <CrStandardIn {...props} />;
}

function CrAddressIn({ value, onValue, onLeave, addressError, label, path, className, id, size, describedBy }: CrInProps) {
  const [longInput, setLongInput] = useState<string | null>(null);
  const text = value === "" ? (longInput ?? "") : String(value);
  const destination = useSuiAddressLookup(text, (address) => {
    setLongInput(null);
    onValue(address);
  });
  const error = destination.name ? destination.error : addressError;
  const description = [error ? `cr-error-${path}` : null, describedBy].filter(Boolean).join(" ") || undefined;

  return <div className={cx(className)}>
    <FieldGroup className={cx("cr-in", "addr", error && "bad")} size={size}>
      <TextField
        aria-describedby={description}
        aria-invalid={!!error || undefined}
        aria-label={label}
        autoCapitalize="off"
        autoComplete="off"
        data-allocation-address=""
        data-f={path}
        id={id}
        onBlur={(event) => {
          destination.lookup(event.currentTarget.value.trim());
          onLeave(path);
        }}
        onChange={(event) => {
          destination.invalidate();
          const input = event.currentTarget.value.trim();
          // Draft address fields are bounded to a hex address. Keep longer names in the control until resolved.
          const tooLong = input.length > 66;
          setLongInput(tooLong ? input : null);
          const draftValue = tooLong ? "" : input;
          if (draftValue !== value) onValue(draftValue);
        }}
        onKeyDown={destination.onKeyDown}
        placeholder={SUI_ADDRESS_PLACEHOLDER}
        size={size}
        spellCheck={false}
        value={text}
      />
      {destination.status === "pending" ? <LoadingIndicator label={SUI_NAME_LOOKUP_LABEL} /> : null}
    </FieldGroup>
    <CrErr message={error ?? ""} path={path} />
    <span className="sr-only" role="status">{destination.confirmation}</span>
  </div>;
}

/** Retain recipient inputs across steps so a lookup can finish after Continue. */
export function AllocationStep({ active, children }: Readonly<{ active: boolean; children: ReactNode }>) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  return active || visited ? <div className={cx("cr-allocation-step")} hidden={!active}>{children}</div> : null;
}

function CrStandardIn(props: CrInProps) {
  const { path, type, value, onLeave, bad, label } = props;
  const [typing, setTyping] = useState<string | null>(null);
  const textual = TEXTUAL_FIELDS.has(type);
  // A zero figure shows as the placeholder, not as "0" typing would join ("0250", #1012).
  const text = textual ? String(value) : (typing ?? (Number(value) === 0 ? "" : fieldText(type, value, props.precision)));
  const describedBy = [bad ? `cr-error-${path}` : null, props.describedBy ?? null].filter(Boolean).join(" ") || undefined;
  return (
    <FieldGroup className={cx("cr-in", type, props.className, bad && "bad")} size={props.size}>
      {props.pre ? <span className={cx("pre")}>{props.pre}</span> : null}
      <TextField
        aria-describedby={describedBy}
        aria-invalid={bad || undefined}
        aria-label={label}
        autoComplete="off"
        data-f={path}
        id={props.id}
        maxLength={props.maxLength}
        onBlur={() => {
          setTyping(null);
          onLeave(path);
        }}
        onChange={(event) => changeField(event.currentTarget, props, textual ? event.currentTarget.value : decimalText(event), raw => { if (!textual) setTyping(raw); })}
        {...(textual ? {} : amountTransfers(props, setTyping))}
        {...fieldTypingAttributes(textual, props.placeholder)}
        size={props.size}
        value={text}
      />
      {props.suf !== undefined ? <span className={cx("suf")}>{props.suf}</span> : null}
    </FieldGroup>
  );
}

/** An error line under a field (`.cr-err`, `role=status`); empty when the field shows none. */
export function CrErr({ path, message }: Readonly<{ path: string; message: string }>) {
  return (
    <span className={cx("cr-err")} data-err={path} id={`cr-error-${path}`} role="status">
      <DiagnosticText message={message} />
    </span>
  );
}

/**
 * A labelled field, as every board draws one: the 13px label over the
 * control, then its help (12px, muted) and its error. With `htmlFor` the
 * label names the control; a group of buttons is named by its own label.
 */
export function CrField({
  label,
  htmlFor,
  help,
  helpId,
  error,
  className,
  children,
}: Readonly<{ label: string; htmlFor?: string; help?: ReactNode; helpId?: string; error?: ReactNode; className?: string; children: ReactNode }>) {
  return (
    <div className={cx("cr-field", className)}>
      {htmlFor ? <label className={cx("cr-label")} htmlFor={htmlFor}>{label}</label> : <span className={cx("cr-label")}>{label}</span>}
      {children}
      {help ? <span className={cx("cr-help")} id={helpId}>{help}</span> : null}
      {error}
    </div>
  );
}

/** A segmented choice (the shared `Segmented`); `stretch` fills its field with equal segments. */
export function CrSeg<Value extends string | number | boolean>({
  label,
  options,
  value,
  onChange,
  disabled,
  stretch = true,
}: Readonly<{ label: string; disabled?: (value: Value) => boolean; options: readonly (readonly [Value, ReactNode])[]; value: Value; onChange: (value: Value) => void; stretch?: boolean }>) {
  return <Segmented className={cx("cr-seg")} label={label} onChange={onChange} optionDisabled={disabled} options={options} stretch={stretch} value={value} />;
}

/** An on/off switch (`.switch`, `role=switch`, the System board's 46 × 28): on is ink, never pink. */
export function CrSwitch({ label, checked, onChange, disabled, controls, path, describedBy }: Readonly<{ label: string; checked: boolean; disabled?: boolean; controls?: string; path?: string; describedBy?: string; onChange: (value: boolean) => void }>) {
  return <button disabled={disabled} data-f={path} aria-describedby={describedBy} aria-controls={controls} aria-checked={checked} aria-label={label} className={cx("switch")} onClick={() => onChange(!checked)} role="switch" type="button" />;
}

export type CoinMarkSize = "s112" | "s72" | "s56" | "s50" | "s46" | "s44" | "";

/**
 * The coin's mark (the design's `crMark`): the logo; else a gradient tile
 * with the name's first letter, its hue from the name; else an empty dashed
 * tile with an image icon.
 */
export function CoinMark({ draft, logo, size }: Readonly<{ draft: Pick<CreateDraft, "name">; logo: string | null; size: CoinMarkSize }>) {
  // One gradient id per mark: the page draws the right column twice (beside the step, and under it below 1220px).
  const gradient = useId();
  if (logo) {
    return (
      <span className={cx("mk", size)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- the uploaded logo, any https host */}
        <img alt="" src={logo} />
      </span>
    );
  }
  const name = draft.name.trim();
  if (!name) {
    return (
      <span className={cx("mk", size, "cr-mk-empty")}>
        <ImageIcon />
      </span>
    );
  }
  const hue = nameHue(name);
  const id = `crm${gradient.replace(/[^\w-]/g, "")}`;
  return (
    <span className={cx("mk", size)}>
      <svg aria-hidden="true" viewBox="0 0 48 48">
        <defs>
          <linearGradient id={id} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor={`hsl(${hue} 80% 66%)`} />
            <stop offset="1" stopColor={`hsl(${(hue + 40) % 360} 70% 44%)`} />
          </linearGradient>
        </defs>
        <rect fill={`url(#${id})`} height="48" width="48" />
        <text dy=".36em" fill="#fff" fontFamily="Geist, -apple-system, system-ui, sans-serif" fontSize="22" fontWeight="700" letterSpacing="-1" textAnchor="middle" x="24" y="24">
          {name[0]!.toUpperCase()}
        </text>
      </svg>
    </span>
  );
}

/** The total beside a bar: a check at 100% (ink, never green), else "x% of 100%". */
export function CrTotal({ bps }: Readonly<{ bps: number }>) {
  return bps === 10_000 ? (
    <span className={cx("cr-total ok")}>
      <CheckIcon />
      {pctText(bps)}
    </span>
  ) : (
    <span className={cx("cr-total bad")}>{pctText(bps)} of 100%</span>
  );
}

/**
 * Whether a folded row is open. It opens itself when the page sends the
 * creator to a field inside (`flashNonce` grows) or a field inside shows an
 * error (`errors`, the shown errors' paths, joined); the creator can still
 * fold it, and a new error opens it again, so an error is never hidden for long.
 */
export function useFold(errors: string, flashNonce: number, initial = false) {
  const [choice, setChoice] = useState<Readonly<{ open: boolean | null; closedAt: number; closedErrors: string }>>({ open: null, closedAt: 0, closedErrors: "" });
  const open = flashNonce > choice.closedAt || (errors !== "" && errors !== choice.closedErrors) || (choice.open ?? initial);
  return { open, toggle: () => setChoice({ open: !open, closedAt: flashNonce, closedErrors: open ? errors : "" }) };
}

export type Fold = ReturnType<typeof useFold>;

/** The folded rows of a step: plain rows in one card under its main card, split by hairlines. */
export function FoldList({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={cx("card cr-card cr-folds")}>{children}</div>;
}

/**
 * A Review group folded into one row ("Splits · Buyers 45%, pool 30%"):
 * pressing it shows the group's rows. Review never opens a group by itself,
 * so the page fits one phone screen: a group with a missing or wrong value
 * names it in the row instead (`attention`, "Splits · Team wallet missing"),
 * in the attention ink. The form steps still open their folds by themselves.
 */
export function ReviewFold({ id, title, value, attention, children }: Readonly<{ id: string; title: string; value: ReactNode; attention: string; children: ReactNode }>) {
  const fold = useFold("", 0);
  return (
    <FoldSection fold={fold} id={id} sectionId={id} title={title} value={attention ? <span className={cx("cr-fold-attn")}>{attention}</span> : value}>
      <div className={cx("cr-group")}><dl>{children}</dl></div>
    </FoldSection>
  );
}

/** The wallet's signatures as one Review row ("Signatures · 3 in your wallet"); pressing it lists them in order. */
export function SignaturesFold({ id, labels, children }: Readonly<{ id: string; labels: readonly SignLabel[]; children?: ReactNode }>) {
  const fold = useFold("", 0);
  return (
    <FoldSection fold={fold} id={id} sectionId={id} title="Signatures" value={`${labels.length} in your wallet`}>
      <ol className={cx("cr-signs")}>
        {labels.map((label, index) => (
          <li key={signLabelText(label)}>
            <span aria-hidden="true" className={cx("n", index === 0 && "next")}>{index + 1}</span>
            <span className={cx("t")}><b><SignLabelText label={label} /></b></span>
          </li>
        ))}
      </ol>
      {children}
    </FoldSection>
  );
}

/**
 * A secondary part of a step folded into one row: its name and its current
 * value ("Buyer vesting · 6 mo, 1-mo cliff"). Pressing the row opens the part
 * in place. The section keeps the part's id (`#cr-join`), so links and fixes
 * still land on it.
 */
export function FoldSection({ id, sectionId, title, value, fold, children }: Readonly<{
  id: string;
  sectionId: string;
  title: string;
  value: ReactNode;
  fold: Fold;
  children: ReactNode;
}>) {
  const panel = useId();
  const heading = `${sectionId}-title`;
  return (
    <section aria-labelledby={heading} className={cx("cr-fold cr-g")} data-sec={id} id={sectionId} tabIndex={-1}>
      <h2 className={cx("cr-fold-h")}>
        <DisclosureButton aria-controls={panel} aria-expanded={fold.open} className={cx("cr-disclosure cr-fold-row")} onClick={fold.toggle} variant="ghost">
          <span className={cx("cr-fold-label")}><span id={heading}>{title}</span> <span className={cx("cr-disclosure-note")}>· {value}</span></span>
        </DisclosureButton>
      </h2>
      <Collapse id={panel} open={fold.open}>
        <div className={cx("cr-collapse-body cr-fold-body")}>{children}</div>
      </Collapse>
    </section>
  );
}

/** An allocation bar and its total share use one layout in every split card. */
export function SplitSummary({ parts, bps, error }: Readonly<{ parts: readonly (readonly [number, string, string])[]; bps: number; error?: string }>) {
  return (
    <div className={cx("cr-bar-row")}>
      <SplitBar parts={parts} />
      {error ? <span className={cx("cr-total bad")}>{error}</span> : <CrTotal bps={bps} />}
    </div>
  );
}

const TEXTUAL_FIELDS = new Set(["text", "sym"]);

/** A number field's paste and drop, with a comma read as `decimalPoint` reads it (#1033). */
function amountTransfers(props: CrInProps, setTyping: (raw: string) => void) {
  const apply = (input: HTMLInputElement) => (raw: string) => changeField(input, props, raw, setTyping);
  return {
    onPaste: (event: ClipboardEvent<HTMLInputElement>) => pasteDecimal(event, apply(event.currentTarget)),
    onDrop: (event: DragEvent<HTMLInputElement>) => dropDecimal(event, apply(event.currentTarget)),
  };
}

function changeField(input: HTMLInputElement, { type, max, precision, onValue }: CrInProps, raw: string, rememberTyping: (raw: string) => void) {
  const parsed = parseField(type, raw, max, precision);
  if (type === "sym" && parsed !== raw) {
    const caret = Math.max(0, (input.selectionStart ?? 0) - (raw.length - String(parsed).length));
    requestAnimationFrame(() => input.setSelectionRange(caret, caret));
  }
  rememberTyping(raw);
  onValue(parsed);
}

/** A signing step as both the review list and the signing sheet write it: "Create $PIP", or the whole phrase with no ticker. */
export function SignLabelText({ label }: Readonly<{ label: SignLabel }>) {
  return label.ticker ? <>{`${label.text} `}<Ticker symbol={label.ticker} /></> : <>{label.text}</>;
}
