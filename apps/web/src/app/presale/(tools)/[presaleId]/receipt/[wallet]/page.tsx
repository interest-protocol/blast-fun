import Link from "next/link";
import { notFound } from "next/navigation";
import { isPresaleId } from "@blast/core/modules/presale/presale-id.ts";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";

export default async function PresaleReceiptPage({ params }: { params: Promise<{ presaleId: string; wallet: string }> }) {
  const { presaleId } = await params;
  if (!isPresaleId(presaleId)) notFound();
  return <section className="card" aria-labelledby="receipt-title">
    <h1 id="receipt-title">Receipt unavailable</h1>
    <Link className="btn btn-primary" href={presalePath(presaleId)}>View presale</Link>
  </section>;
}
