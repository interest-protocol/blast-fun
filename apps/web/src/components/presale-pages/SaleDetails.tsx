"use client";

import { IconButton } from "#web/components/blast-ui/Button.tsx";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { Sheet, SheetClose, SheetCta, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { isEnterSubmit } from "#web/lib/ime-enter.ts";
import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import type { SocialApiOptions } from "#web/components/social/social-api.ts";
import { VIEWER_STALE_MS, unwrapApiResult } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";
import { SALE_TAGLINE_MAX, type SaleMetadataField, type SocialSaleMetadata, type SocialSaleMetadataResponse } from "@blast/core/web/contracts/sales.ts";
import { saleLinkLabel, saleTaglineLength } from "@blast/core/modules/social/sales/validate.ts";
import { presaleXIntent } from "#web/modules/presale/share/metadata.ts";

import { DocIcon, ImageIcon, LinkIcon, ShieldIcon, TelegramIcon, UploadIcon, XMark } from "./icons";
import { EDIT_DETAILS_FIELDS, coverTooLarge, editFieldMessage, editInputValue, editRequestOf, editValuesOf, fetchSaleDetails, saleDetailsRefusal, saveSaleDetails, uploadSaleCover, type EditDetailsValues } from "./sale-details";
import styles from "./SaleDetails.module.css";

/**
 * A sale's public details on its page (R3-28, FEATURE-MAP-R3 §10): the cover
 * across the hero, the tagline, the outbound links, and for the sale's
 * creator the cover button and the "Edit details" sheet. The details arrive
 * server-rendered with the page; whether the viewer may edit them is asked in
 * the browser (`GET /api/social/sales/{id}/metadata`), since the page's HTML
 * is the same for every reader.
 */

const signedOut = async () => null;
const COVER_TYPES = "image/png,image/jpeg,image/webp";

export type SaleDetailsState = Readonly<{
  metadata: SocialSaleMetadata | null;
  /** The viewer holds the sale's cap and the sale is not cancelled. */
  editable: boolean;
  api: SocialApiOptions;
  /** Takes a route's answer as the page's details. */
  adopt: (metadata: SocialSaleMetadata) => void;
}>;

/** The sale's details as the page shows them, and whether this viewer may change them. */
export function useSaleDetails(sale: SocialPresaleSummary): SaleDetailsState {
  const viewer = useSocialViewer();
  const [state, setState] = useState<{ id: string; metadata: SocialSaleMetadata | null; editable: boolean }>({
    id: sale.presale_id,
    metadata: sale.metadata,
    editable: false,
  });
  // Another sale, or a fresher server read of this one, resets what the page shows.
  const [seen, setSeen] = useState(sale.metadata);
  if (state.id !== sale.presale_id || seen !== sale.metadata) {
    setSeen(sale.metadata);
    setState({ id: sale.presale_id, metadata: sale.metadata, editable: state.id === sale.presale_id && state.editable });
  }
  const api = useMemo<SocialApiOptions>(() => ({ getAccessToken: viewer.getAccessToken ?? signedOut }), [viewer.getAccessToken]);
  const cancelled = sale.phase === "cancelled";
  // Whether this viewer may edit: the sale's metadata read with their credentials (a shared query, OA-38).
  const queries = useAppQueryClient();
  const own = useQuery(
    {
      queryKey: queryKeys.me.saleMetadata(sale.presale_id),
      queryFn: async () => unwrapApiResult(await fetchSaleDetails(api, sale.presale_id)),
      staleTime: VIEWER_STALE_MS,
      enabled: viewer.signedIn && !cancelled,
    },
    queries,
  );
  const editable = state.editable || own.data?.editable === true;
  return {
    metadata: state.metadata,
    editable: editable && viewer.signedIn && !cancelled,
    api,
    adopt: (metadata) => {
      setState((current) => ({ ...current, metadata }));
      // The save's answer is the metadata now; the sale's public read (Blast mode's panel) is out of date.
      queries.setQueryData<SocialSaleMetadataResponse>(queryKeys.me.saleMetadata(sale.presale_id), (held) => (held ? { ...held, metadata } : held));
      void queries.invalidateQueries({ queryKey: queryKeys.presales.detail(sale.presale_id), exact: true }, { cancelRefetch: false });
    },
  };
}

/** The picked image's handler: one file, its size checked before anything is sent. */
function useCoverChange(onFile: (file: File) => void) {
  const toast = useToast();
  return (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (coverTooLarge(file)) {
      toast("Use an image under 4 MB");
      return;
    }
    onFile(file);
  };
}

/** The creator's "Change cover" in the header footer, reachable by keyboard. */
export function CoverButton({ sale, details }: Readonly<{ sale: SocialPresaleSummary; details: SaleDetailsState }>) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const onChange = useCoverChange(async (file) => {
    setBusy(true);
    // The button frees itself even when the upload throws.
    const upload = async () => {
      const result = await uploadSaleCover(details.api, sale.presale_id, file);
      if (result.status === "ok") {
        details.adopt(result.body.metadata);
      } else {
        toast(saleDetailsRefusal(result));
      }
    };
    await upload().finally(() => setBusy(false));
  });
  return (
    <>
      <IconButton aria-label="Change cover" loading={busy} loadingLabel="Uploading cover" onClick={() => input.current?.click()} size="touch" title="Change cover" variant="secondary">
        <ImageIcon />
      </IconButton>
      <input accept={COVER_TYPES} aria-label="Cover image" className={styles.file} onChange={onChange} ref={input} tabIndex={-1} type="file" />
    </>
  );
}

/** An outbound link the creator stored: never followed by search engines, never given the opener. */
function Outbound({ href, children }: Readonly<{ href: string; children: ReactNode }>) {
  return (
    <a href={href} rel="nofollow noopener" target="_blank">
      {children}
    </a>
  );
}

/**
 * The sale's stored links plus its always-available X share action. In the
 * About card (`about`) they are the Sale board's chips: Website, X,
 * Telegram, Docs and Audit report, without the share action, which the
 * page's meta line carries. An audit link is only a link: the `Audited`
 * pill is Blast's to set (R3-23).
 */
export function SaleLinks({ sale, metadata, about = false }: Readonly<{ sale: SocialPresaleSummary; metadata: SocialSaleMetadata | null; about?: boolean }>) {
  const icon = (glyph: ReactNode) => (about ? null : glyph);
  return (
    <>
      {metadata?.site ? (
        <Outbound href={metadata.site}>
          {icon(<LinkIcon />)}
          <span>{about ? "Website" : saleLinkLabel(metadata.site)}</span>
        </Outbound>
      ) : null}
      {metadata?.x_handle ? (
        <Outbound href={`https://x.com/${metadata.x_handle}`}>
          {about ? <span aria-label={`X, @${metadata.x_handle}`}>X</span> : <><XMark />@{metadata.x_handle}</>}
        </Outbound>
      ) : null}
      {about ? null : (
        <a href={presaleXIntent({ ...sale, metadata })} rel="noopener noreferrer" target="_blank">
          <XMark />
          Share on X
        </a>
      )}
      {metadata?.telegram ? (
        <Outbound href={`https://t.me/${metadata.telegram}`}>
          {icon(<TelegramIcon />)}
          Telegram
        </Outbound>
      ) : null}
      {metadata?.docs_url ? (
        <Outbound href={metadata.docs_url}>
          {icon(<DocIcon />)}
          Docs
        </Outbound>
      ) : null}
      {metadata?.audit_url ? (
        <Outbound href={metadata.audit_url}>
          {icon(<ShieldIcon />)}
          Audit report
        </Outbound>
      ) : null}
    </>
  );
}

type StagedCover = Readonly<{ file: File; preview: string }> | null;

/**
 * "Edit details" (FEATURE-MAP-R3 §10): the cover, the one-line description
 * with its counter, and the five links, each with the gate's inline error.
 * Save uploads a picked cover first, then the fields; `Save` reads `Saving`
 * meanwhile, then closes onto the updated page. The sheet never offers a term of
 * the sale: every input is a metadata column (`EDIT_DETAILS_FIELDS`).
 */
export function EditDetailsSheet({
  open,
  sale,
  details,
  onClose,
}: Readonly<{ open: boolean; sale: SocialPresaleSummary; details: SaleDetailsState; onClose: () => void }>) {
  const [values, setValues] = useState<EditDetailsValues>(() => editValuesOf(details.metadata));
  const [cover, setCover] = useState<StagedCover>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const first = useRef<HTMLInputElement>(null);
  // Each opening starts from what the page shows.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValues(editValuesOf(details.metadata));
      setCover(null);
      setMessage(null);
    }
  }
  useEffect(() => () => {
    if (cover) URL.revokeObjectURL(cover.preview);
  }, [cover]);
  const coverInput = useRef<HTMLInputElement>(null);
  const onCover = useCoverChange((file) => setCover({ file, preview: URL.createObjectURL(file) }));
  const errors = Object.fromEntries(EDIT_DETAILS_FIELDS.map((field) => [field.key, editFieldMessage(field.key, values[field.key])])) as Record<SaleMetadataField, string>;
  const bad = Object.values(errors).some(Boolean);
  const shownCover = cover?.preview ?? details.metadata?.cover?.url ?? null;
  const taglineLength = saleTaglineLength(values.tagline);
  const titleId = `edit-sale-${sale.presale_id.slice(-6)}`;

  async function save() {
    if (saving || bad) return;
    setSaving(true);
    setMessage(null);
    // Saving ends however the writes end, even when one throws.
    const write = async () => {
      if (cover) {
        const uploaded = await uploadSaleCover(details.api, sale.presale_id, cover.file);
        if (uploaded.status !== "ok") {
          setMessage(saleDetailsRefusal(uploaded));
          return;
        }
        details.adopt(uploaded.body.metadata);
        setCover(null);
      }
      const saved = await saveSaleDetails(details.api, sale.presale_id, editRequestOf(values));
      if (saved.status !== "ok") {
        setMessage(saleDetailsRefusal(saved));
        return;
      }
      details.adopt(saved.body.metadata);
      onClose();
    };
    await write().finally(() => setSaving(false));
  }

  return (
    <Sheet className={styles.sheet} hasCta initialFocus={() => first.current} labelledBy={titleId} onRequestClose={onClose} open={open}>
      <span className={styles.label} id={titleId}>
        Edit {sale.name}&apos;s details
      </span>
      <SheetClose onClick={onClose} />
      <SheetHeading id={`${titleId}-h`} title="Edit details" />
      <div className={styles.cover}>
        {shownCover ? (
          // eslint-disable-next-line @next/next/no-img-element -- the stored cover, or the picked file's preview
          <img alt="" height={512} src={shownCover} width={1_536} />
        ) : null}
        <button className="btn btn-quiet btn-sm" disabled={saving} onClick={() => coverInput.current?.click()} type="button">
          <UploadIcon />
          {shownCover ? "Replace cover" : "Add a cover"}
        </button>
        <input accept={COVER_TYPES} aria-label={shownCover ? "Replace cover" : "Add a cover"} className={styles.file} onChange={onCover} ref={coverInput} tabIndex={-1} type="file" />
      </div>
      {EDIT_DETAILS_FIELDS.map((field, index) => {
        const id = `${titleId}-${field.key}`;
        const error = errors[field.key];
        return (
          <div className={styles.field} key={field.key}>
            <label htmlFor={id}>{field.label}</label>
            <div className={styles.input} data-invalid={error ? "" : undefined}>
              {field.pre ? <span className={styles.pre}>{field.pre}</span> : null}
              <input
                aria-describedby={`${id}-msg`}
                aria-invalid={error ? true : undefined}
                autoComplete="off"
                disabled={saving}
                id={id}
                maxLength={field.maxLength}
                onChange={(event) => {
                  const value = editInputValue(field.key, event.currentTarget.value);
                  setValues((current) => ({ ...current, [field.key]: value }));
                  setMessage(null);
                }}
                onKeyDown={(event) => {
                  if (isEnterSubmit(event)) void save();
                }}
                placeholder={field.placeholder}
                ref={index === 0 ? first : undefined}
                spellCheck={false}
                value={values[field.key]}
              />
              {field.key === "tagline" ? (
                <span aria-hidden="true" className={styles.count} data-over={taglineLength > SALE_TAGLINE_MAX || undefined}>
                  {taglineLength}/{SALE_TAGLINE_MAX}
                </span>
              ) : null}
            </div>
            <span aria-live="polite" className={styles.msg} data-tone={error ? "bad" : undefined} id={`${id}-msg`}>
              {error}
            </span>
          </div>
        );
      })}
      {message ? (
        <p className={styles.msg} data-tone="bad" role="alert">
          {message}
        </p>
      ) : null}
      <SheetCta>
        <button className="btn btn-primary btn-lg btn-block" disabled={bad || saving} onClick={() => void save()} type="button">
          {saving ? (
            <>
              <span aria-hidden="true" className={styles.spin} />
              Saving
            </>
          ) : "Save"}
        </button>
      </SheetCta>
    </Sheet>
  );
}
