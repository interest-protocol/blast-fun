import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { RetryingCardImage } from "#web/components/mission-control/RetryingCardImage.tsx";
import { publicCardImagePath } from "@blast/core/modules/mission-control/card-images/contracts.ts";
import { publicCardMetadata } from "#web/modules/mission-control/card-images/public-card-metadata.ts";
import { readCardPageFromBackend } from "#web/lib/backend-api/cards.ts";
import styles from "./page.module.css";
const getCard = cache(readCardPageFromBackend);
export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const card = await getCard(id);
  if (!card) return { title: "Card not found" };
  return publicCardMetadata(card, id, card.recruitTotal);
}
export default async function PublicCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await getCard(id);
  if (!card) notFound();
  return (
    <main className={styles.page}>
      <h1 className={styles.srOnly}>BLAST Season Zero card for crew #{card.crew}</h1>
      <RetryingCardImage
        className={styles.card}
        src={publicCardImagePath(id, "card")}
        alt={`BLAST Season Zero card for @${card.callsign}, crew #${card.crew}`}
        width={2100}
        height={1500}
        unoptimized
        priority
      />
    </main>
  );
}
