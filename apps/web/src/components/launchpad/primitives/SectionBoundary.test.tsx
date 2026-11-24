import assert from "node:assert/strict";
import test from "node:test";
import { notFound, redirect } from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";

import type { SectionState } from "./data-state";
import { DataState } from "./DataState";
import { SectionBoundary, SectionFailed } from "./SectionBoundary";

const provenance = {
  network: "mainnet",
  deployment: "0x5b1a",
  checkpoint: "182734455",
  observedAt: "2026-09-30T14:02:11.000Z",
  lagMs: 900,
} as const;

function Section({ subject, state }: Readonly<{ subject: string; state: SectionState<string> }>) {
  return (
    <section aria-label={subject}>
      <SectionBoundary subject={subject}>
        <DataState state={state} subject={subject}>
          {(fact) => <p>{fact}</p>}
        </DataState>
      </SectionBoundary>
    </section>
  );
}

test("holder, social, identity and venue sections degrade independently", () => {
  const html = renderToStaticMarkup(
    <main>
      <h1>HELMET</h1>
      <Section subject="holders" state={{ status: "unavailable", reason: "The holder index did not respond" }} />
      <Section subject="social posts" state={{ status: "loading" }} />
      <Section subject="identity" state={{ status: "ready", value: "Creator verified on X", provenance }} />
      <Section subject="venues" state={{ status: "stale", value: "Cetus pool listed", provenance, reason: "Venue feed paused" }} />
    </main>,
  );
  assert.match(html, /<h1>HELMET<\/h1>/, "the permanent page stays");
  assert.match(html, /aria-label="holders"><div[^>]*data-state="unavailable"/);
  assert.match(html, /aria-label="social posts"><div[^>]*data-state="loading"/);
  assert.match(html, /<p>Creator verified on X<\/p>/, "verified sibling facts stay");
  assert.match(html, /data-state="stale".*<p>Cetus pool listed<\/p>/);
});

test("a section that fails to render says so in place of its facts", () => {
  const html = renderToStaticMarkup(<SectionFailed subject="holders" />);
  assert.match(html, /data-state="unavailable"/);
  assert.match(
    html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    /^Unavailable Holders could not be shown\. The rest of the page is unaffected\. Reload the page to try again\.$/,
  );
});

function Broken(): never {
  throw new Error("holder rows were malformed");
}

test("a section that throws during the server render leaves siblings and the page rendered", () => {
  const html = renderToStaticMarkup(
    <main>
      <h1>HELMET</h1>
      <SectionBoundary subject="holders">
        <Broken />
      </SectionBoundary>
      <Section subject="identity" state={{ status: "ready", value: "Creator verified on X", provenance }} />
    </main>,
  );
  assert.match(html, /<h1>HELMET<\/h1>/);
  assert.match(html, /<p>Creator verified on X<\/p>/);
  assert.doesNotMatch(html, /malformed/);
  // The browser retries the section and shows SectionFailed if it throws again.
  assert.match(html, /data-state="loading"/);
});

function thrownBy(navigate: () => never): unknown {
  try {
    navigate();
  } catch (error) {
    return error;
  }
  throw new Error("expected the navigation call to throw");
}

test("notFound() and redirect() pass through the boundary to Next instead of failing the section", () => {
  for (const error of [thrownBy(() => notFound()), thrownBy(() => redirect("/"))]) {
    assert.throws(() => SectionBoundary.getDerivedStateFromError(error), (thrown) => thrown === error);
  }
});

test("ordinary render errors still fail only the section", () => {
  assert.deepEqual(SectionBoundary.getDerivedStateFromError(new Error("malformed rows")), { failed: true });
});

test("a failing section that owns the page heading keeps the heading", () => {
  const heading = <h1>Trading terminal</h1>;
  const server = renderToStaticMarkup(
    <SectionBoundary subject="the selected coin" heading={heading}>
      <Broken />
    </SectionBoundary>,
  );
  assert.match(server, /<h1>Trading terminal<\/h1>.*data-state="loading"/);
  const browser = renderToStaticMarkup(<SectionFailed subject="the selected coin" heading={heading} />);
  assert.match(browser, /<h1>Trading terminal<\/h1>.*data-state="unavailable"/);
});
