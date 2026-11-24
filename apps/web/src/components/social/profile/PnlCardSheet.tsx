"use client";

import { SelectField } from "#web/components/blast-ui/TextField.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { PendingStatus, SkeletonBox } from "#web/components/blast-ui/Skeleton.tsx";
import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { referralPath } from "@blast/core/modules/social/referrals/contracts.ts";
import { Sheet, SheetClose, SheetCta, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { useSocialViewer } from "../SignInGate";
import { sharePnlCardOnX } from "./pnl-card-sharing";
import { PNL_CARD_MEMES, defaultPnlCardTemplate, pnlCardDescription, pnlCardPng, pnlCardTemplates, type PnlCard, type PnlCardMeme, type PnlCardTemplate } from "./pnl-card";
import styles from "./Profile.module.css";

type RenderedCard = { url: string; file: File; card: PnlCard; attempt: number; meme: PnlCardMeme; template: PnlCardTemplate };

function matchesCardImage(rendered: RenderedCard | null, current: Omit<RenderedCard, "url" | "file">) {
  return rendered?.card === current.card && rendered?.attempt === current.attempt && rendered?.meme === current.meme && rendered?.template === current.template;
}

function availableCaptions(templates: ReturnType<typeof pnlCardTemplates>) {
  return PNL_CARD_MEMES.filter((option) => {
    if (option.value === "printer") return templates.some((design) => design.value === "money-printer");
    if (option.value === "fine" || option.value === "last") return templates.some((design) => design.value === "death");
    return true;
  });
}

function CardActions({ image, filename, sharing, status, share, shareOnX, retry }: Readonly<{
  image: { url: string; file: File } | null; filename: string; sharing: boolean; status: string;
  share: () => void; shareOnX: () => void; retry: () => void;
}>) {
  return <SheetCta className={styles.pnlCardActions}>
    {image ? <>
      <button className="btn btn-ink" disabled={sharing} onClick={shareOnX} type="button">{sharing ? <LoadingIndicator label="Preparing your card link">Share on X</LoadingIndicator> : "Share on X"}</button>
      <a className="btn btn-line" download={filename} href={image.url}>Download PNG</a>
      {typeof navigator !== "undefined" && navigator.canShare?.({ files: [image.file] }) ? <button className="btn btn-line" disabled={sharing} onClick={share} type="button">{sharing ? <LoadingIndicator label="Sharing card">Share card</LoadingIndicator> : "Share card"}</button> : null}
    </> : status === "Card could not render. Try again." ? <button className="btn btn-line" onClick={retry} type="button">Retry card</button> : null}
  </SheetCta>;
}

function CardPreview({ card, failed, image }: Readonly<{ card: PnlCard; failed: boolean; image: RenderedCard | null }>) {
  return <div aria-busy={!image && !failed} className={styles.pnlCardCanvas}>
    {image ? <Image alt={pnlCardDescription(card)} className={styles.pnlCardPreview} height={675} src={image.url} unoptimized width={1200} /> : failed ? null : <><SkeletonBox className={styles.pnlCardSkeleton} /><PendingStatus label="Creating PnL card" /></>}
  </div>;
}

export default function PnlCardSheet({ card, onClose }: Readonly<{ card: PnlCard; onClose: () => void }>) {
  const viewer = useSocialViewer();
  const heading = useId();
  const shareRequest = useRef<AbortController | null>(null);
  const [chosenMeme, setMeme] = useState<PnlCardMeme>("auto");
  const [chosenTemplate, setTemplate] = useState<PnlCardTemplate>(() => defaultPnlCardTemplate(card));
  const templates = pnlCardTemplates(card);
  const template = templates.find((option) => option.value === chosenTemplate)?.value ?? defaultPnlCardTemplate(card);
  const captions = availableCaptions(templates);
  const meme = captions.find((option) => option.value === chosenMeme)?.value ?? "auto";
  const [open, setOpen] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [rendered, setRendered] = useState<RenderedCard | null>(null);
  const image = matchesCardImage(rendered, { card, attempt, meme, template }) ? rendered : null;
  const [status, setStatus] = useState("Creating PnL card…");
  const [sharing, setSharing] = useState(false);
  const filename = `blast-pnl-${card.callsign}-${card.asset?.symbol ?? "since-launch"}`.replace(/[^a-z0-9_-]/gi, "_").slice(0, 160) + ".png";

  useEffect(() => () => { shareRequest.current?.abort(); }, []);

  function close() {
    shareRequest.current?.abort();
    setOpen(false);
  }

  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    const render = async () => pnlCardPng(card, { meme, template });
    render().then((blob) => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setRendered({ url, file: new File([blob], filename, { type: "image/png" }), card, attempt, meme, template });
      setStatus("");
    }).catch(() => {
      if (!cancelled) setStatus("Card could not render. Try again.");
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [card, filename, attempt, meme, template]);

  async function share() {
    if (!image || sharing) return;
    setSharing(true);
    setStatus("");
    try {
      await navigator.share({ files: [image.file], title: "My Blast PnL", url: new URL(referralPath(card.callsign), window.location.origin).href });
      setStatus("Card shared.");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setStatus("Sharing unavailable. Download the PNG instead.");
    }
    setSharing(false);
  }

  async function shareOnX() {
    if (!image || sharing) return;
    const controller = new AbortController();
    shareRequest.current = controller;
    setSharing(true);
    setStatus("Preparing your card link…");
    const message = await sharePnlCardOnX(image.file, { getAccessToken: viewer.getAccessToken ?? (async () => null) }, controller);
    if (!controller.signal.aborted) setStatus(message);
    setSharing(false);
    shareRequest.current = null;
  }

  return <Sheet hasCta labelledBy={heading} onClosed={onClose} onRequestClose={close} open={open}>
    <SheetClose onClick={close} />
    <SheetHeading id={heading} title="Your PnL card" lead={<span className={styles.pnlCardLabel}>{card.asset ? `$${card.asset.symbol} · Since launch` : "Account · Since launch"}</span>} />
    <CardPreview card={card} failed={status === "Card could not render. Try again."} image={image} />
    <fieldset className={styles.pnlCardTemplates} disabled={sharing}>
      <legend>Card style</legend>
      <div className={styles.pnlCardTemplateGrid}>
        {templates.map((option) => <label className={styles.pnlCardTemplate} key={option.value}>
          <input checked={template === option.value} name={`${heading}-style`} onChange={() => { setTemplate(option.value); setMeme("auto"); setStatus("Creating PnL card…"); }} type="radio" value={option.value} />
          <span className={styles.pnlCardTemplateArt}><Image alt="" height={675} src={option.artwork} unoptimized width={1200} /></span>
          <span>{option.label}</span>
        </label>)}
      </div>
    </fieldset>
    <div className={styles.pnlCardEditor}>
      <div className={styles.field}>
        <label htmlFor={`${heading}-meme`}>Meme caption</label>
        <SelectField disabled={sharing} id={`${heading}-meme`} onChange={(event) => { const selected = captions.find((option) => option.value === event.target.value); if (selected) { setMeme(selected.value); if (selected.value === "last") setTemplate("death"); setStatus("Creating PnL card…"); } }} value={meme}>
          {captions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </SelectField>
      </div>
    </div>
    <p className={styles.pnlNote}>Sharing on X creates a public card link.</p>
    <p aria-live="polite" className={styles.pnlNote} role="status">{status === "Creating PnL card…" || sharing ? <span className="sr">{status}</span> : status}</p>
    <CardActions filename={filename} image={image} retry={() => { setStatus("Creating PnL card…"); setAttempt(attempt + 1); }} share={() => void share()} shareOnX={() => void shareOnX()} sharing={sharing} status={status} />
  </Sheet>;
}
