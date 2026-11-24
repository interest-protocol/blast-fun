import { AppShell } from "#web/components/blast-ui/AppShell";
import { BlastUiRoot } from "#web/components/blast-ui/BlastUiRoot";
import { PageHeader } from "#web/components/blast-ui/PageHeader";
import { PORTFOLIO_UNAVAILABLE } from "#web/components/blast-ui/portfolio";
import { SheetHeading } from "#web/components/blast-ui/Sheet";

export const metadata = {
  title: "Shell typography proof",
  robots: { index: false, follow: false },
};

/** #799: real Next font transformation, root wiring and UI roles; no wallet or data provider. */
export default function Page() {
  return (
    <BlastUiRoot nonce={null}>
      <AppShell
        currentItem="portfolio"
        portfolio={PORTFOLIO_UNAVAILABLE}
        signedIn={false}
        signInHref="/sign-in"
        viewer={null}
      >
        <PageHeader title="Shell typography proof" />
        <p id="typography-body">The quick brown fox reads 11,881.18.</p>
        <SheetHeading id="typography-sheet" title="Your account" />
      </AppShell>
    </BlastUiRoot>
  );
}
