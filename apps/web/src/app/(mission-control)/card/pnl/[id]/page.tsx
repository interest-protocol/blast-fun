import Image from "next/image";
import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import { referralCallsign, referralPath } from "@blast/core/modules/social/referrals/contracts.ts";
import { pnlCardSharePath } from "@blast/core/modules/social/contracts/pnl-card-sharing.ts";
import { pnlCardShareMetadata } from "#web/modules/social/pnl-card-metadata.ts";
import { readPnlPageFromBackend } from "#web/lib/backend-api/cards.ts";
import styles from "./page.module.css";

const getCard = cache(readPnlPageFromBackend);
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ ref?: string | string[] }> };

export async function generateMetadata({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!(await getCard(id)).exists) notFound();
  return pnlCardShareMetadata(id, referralCallsign(query.ref) ?? undefined);
}

export default async function SharedPnlCard({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!(await getCard(id)).exists) notFound();
  const callsign = referralCallsign(query.ref);
  return <main className={styles.page}>
    <h1>Blast PnL card</h1>
    <Image alt="Shared PnL since launch card" className={styles.card} height={675} loading="eager" src={`${pnlCardSharePath(id)}/image`} unoptimized width={1200} />
    <Link className={styles.enter} href={callsign ? referralPath(callsign) : "/"}>Trade on Blast</Link>
  </main>;
}
