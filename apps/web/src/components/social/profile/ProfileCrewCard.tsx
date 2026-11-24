"use client";

import { DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { PublicError, publicErrorMessage, responseError, responseDiagnostic, diagnosticMessage } from "#web/lib/errors.ts";

import { useEffect, useRef, useState } from "react";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { ChevronIcon } from "#web/components/blast-ui/Icons.tsx";
import { RetryingCardImage } from "#web/components/mission-control/RetryingCardImage.tsx";
import { ownerCardFilename } from "#web/components/mission-control/owner-card-actions.ts";
import { publicCardImagePath } from "@blast/core/modules/mission-control/card-images/contracts.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { CARD_EDITION_NAMES } from "@blast/core/web/card-editions.ts";
import { OWNER_CARD_PATH } from "@blast/core/web/contracts/card-identity.ts";
import { useCardIdentityQuery } from "../card-identity-query";
import { useSocialViewer } from "../SignInGate";
import { socialRequestAuth, type AccessTokenSource } from "../social-fetch";
import styles from "./Profile.module.css";

async function crewCardBlob(path: string, getAccessToken: AccessTokenSource | undefined, signal: AbortSignal): Promise<Blob> {
  const auth = path === OWNER_CARD_PATH ? await socialRequestAuth(getAccessToken) : { headers: {}, credentials: "same-origin" as const };
  if (!auth) throw new PublicError("Sign in again to view your crew card.", { code: "authentication_unavailable" });
  const response = await gatedFetch(path, { ...auth, cache: path === OWNER_CARD_PATH ? "no-store" : "default", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  if (!response.ok) throw responseError(await response.json().catch(() => null), response);
  const blob = await response.blob();
  if (blob.type !== "image/png") throw new PublicError("Crew card unavailable. Try again.", { ...responseDiagnostic(response), code: "invalid_response" });
  return blob;
}

export function ProfileCrewCard({ callsign, own, loading = false }: Readonly<{ callsign: string; own: boolean; loading?: boolean }>) {
  const identity = useCardIdentityQuery(callsign);
  const card = identity.data;
  const viewer = useSocialViewer();
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {
    request.current?.abort();
  }, []);
  // Public images need no owner session; unpublished artwork is read only through the authenticated social route.
  const path = card?.published_card_id ? publicCardImagePath(card.published_card_id, "card") : OWNER_CARD_PATH;

  async function viewCard() {
    if (busy) return;
    request.current?.abort();
    setImage(null);
    setOpen(true);
    setBusy(true);
    setStatus("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const blob = await crewCardBlob(path, viewer.getAccessToken, controller.signal).finally(() => setBusy(false));
      if (!controller.signal.aborted) {
        const url = URL.createObjectURL(blob);
        setImage(url);
        setStatus("");
        await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      if (!controller.signal.aborted) setStatus(publicErrorMessage(error, "Crew card unavailable. Try again."));
    }
  }

  function close() {
    request.current?.abort();
    setOpen(false);
  }

  // This row is optional. Only reserve its shape after a card is known to exist.
  if (!card) return null;
  if (loading || identity.isPending) return <ProfileCrewCardSkeleton own={own} />;
  return (
    <div className={styles.crewCard}>
      <div className={styles.crewCardDetails}>
        <span className={styles.crewCardTitle}>{CARD_EDITION_NAMES[card.edition]} card</span>
        <span className={styles.crewCardNumber}>Season Zero · Crew #{String(card.crew).padStart(4, "0")}</span>
      </div>
      {own || card.published_card_id ? <DisclosureButton aria-haspopup="dialog" className={styles.crewCardAction} onClick={() => void viewCard()} type="button">View card</DisclosureButton> : null}
      <Sheet labelledBy="crew-card-heading" onRequestClose={close} open={open}
        onClosed={() => setImage(null)}>
        <SheetClose onClick={close} />
        <SheetHeading id="crew-card-heading" title={`${CARD_EDITION_NAMES[card.edition]} card`} />
        <p>Season Zero · Crew #{String(card.crew).padStart(4, "0")}</p>
        {busy ? <CrewCardPreviewLoading /> : null}
        {image ? <RetryingCardImage alt={`Season Zero ${CARD_EDITION_NAMES[card.edition]} card for @${callsign}, crew ${card.crew}`} className={styles.crewCardImage} height={1500} onGiveUp={() => setStatus(diagnosticMessage("Card preview unavailable. Try again.", { code: "invalid_response" }))} src={image} unoptimized width={2100} /> : null}
        <p aria-live="polite" hidden={!status} role="status">{status}</p>
        {own && image ? <a className="btn btn-ink" download={ownerCardFilename(callsign)} href={image}>Download PNG</a> : null}
        {!busy && status ? <button className="btn btn-line" onClick={() => void viewCard()} type="button">Retry card</button> : null}
      </Sheet>
    </div>
  );
}

function ProfileCrewCardSkeleton({ own }: Readonly<{ own: boolean }>) {
  return <div aria-hidden="true" className={styles.crewCard}>
    <div className={styles.crewCardDetails}>
      <span className={styles.crewCardTitle}><SkeletonText>Edition card</SkeletonText></span>
      <span className={styles.crewCardNumber}><SkeletonText>Season Zero · Crew #0000</SkeletonText></span>
    </div>
    {own ? <span className={`btn btn-quiet ${styles.crewCardAction}`}><SkeletonText>View card</SkeletonText><ChevronIcon /></span> : null}
  </div>;
}

function CrewCardPreviewLoading() {
  return <div aria-busy="true" aria-label="Loading crew card" className={styles.crewCardPreviewLoading} role="status">
    <div aria-hidden="true" className={styles.crewCardPreviewArtwork} />
    <div aria-hidden="true" className={styles.crewCardPreviewDetails}>
      <SkeletonText>Season Zero crew card</SkeletonText>
      <SkeletonText>Edition · Crew #0000</SkeletonText>
    </div>
  </div>;
}
