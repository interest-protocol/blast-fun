import Link from "next/link";

/** The shared presale not-found view: unknown or malformed presale paths. */
export function PresaleNotFound() {
  return (
    <main>
      <h1>Presale not found</h1>

      <Link href="/presale">See all presales</Link>
    </main>
  );
}
