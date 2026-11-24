import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { MetadataRoute } from "next";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LaunchpadNotFound } from "#web/components/launchpad/LaunchpadNotFound.tsx";
import { LaunchpadShell } from "#web/components/launchpad/LaunchpadShell.tsx";
import { LaunchpadSearch } from "#web/components/launchpad/search/LaunchpadSearch.tsx";
import { installRequestHeaders, setRequestCookie, setRequestHeaders } from "../../test/fixtures/lib/request-headers.testing.ts";
import { useWebConfig } from "../../test/fixtures/lib/web-config.testing.ts";
import { sitemapEntries } from "#web/lib/sitemap-entries.ts";

import * as robotsModule from "./robots";
import * as sitemapModule from "./sitemap";


installRequestHeaders();
const { default: NotFound } = await import("./not-found");

const sitemap = sitemapModule.default;
const robots = robotsModule.default;

/**
 * T-031-AC-1 (AC-138): while `BLAST_LAUNCHPAD_ENABLED` is not exactly `true`,
 * the app-wide not-found page and the sitemap show no launchpad UI and no link
 * into a launchpad namespace. With it on, both are as on the base.
 */

const BOOSTS_URL = "https://boosts.example.com/blast";
const LAUNCHPAD_LINK = /\/(coin|launch|api\/launchpad|dev\/launchpad)(\/|"|$|\?)/;

async function withLaunchpadFlag<Value>(value: string | undefined, read: () => Promise<Value>): Promise<Value> {
  const previous = process.env.BLAST_LAUNCHPAD_ENABLED;
  if (value === undefined) delete process.env.BLAST_LAUNCHPAD_ENABLED;
  else process.env.BLAST_LAUNCHPAD_ENABLED = value;
  try {
    return await read();
  } finally {
    if (previous === undefined) delete process.env.BLAST_LAUNCHPAD_ENABLED;
    else process.env.BLAST_LAUNCHPAD_ENABLED = previous;
  }
}

test("T-031-AC-1: with the launchpad off the not-found page is neutral: no launchpad shell, search, Boosts link or launchpad link", async (t) => {
  useWebConfig(t, { BLAST_BOOSTS_URL: BOOSTS_URL });
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    const page = await withLaunchpadFlag(flag, async () => NotFound());
    const tree = page as ReactElement;
    assert.notEqual(tree.type, LaunchpadShell, `flag=${flag}`);
    const html = renderToStaticMarkup(tree);
    assert.match(html, /Page not found/, `flag=${flag}`);
    assert.doesNotMatch(html, LAUNCHPAD_LINK, `flag=${flag}: ${html}`);
    assert.doesNotMatch(html, /boosts\.example\.com|terminal|search/i, `flag=${flag}: ${html}`);
    assert.doesNotMatch(html, /<a\s/, `flag=${flag}: no link at all`);
  }
});

test("T-031-AC-1: with the launchpad on the not-found page is the base's launchpad shell, search, Boosts link and message", async (t) => {
  useWebConfig(t, { BLAST_BOOSTS_URL: BOOSTS_URL });
  const page = (await withLaunchpadFlag("true", async () => NotFound())) as ReactElement<{
    boostsUrl: unknown;
    search: unknown;
    children: unknown;
  }>;
  assert.equal(page.type, LaunchpadShell);
  assert.equal(page.props.boostsUrl, BOOSTS_URL);
  assert.ok(isValidElement(page.props.search) && page.props.search.type === LaunchpadSearch);
  assert.ok(isValidElement(page.props.children) && page.props.children.type === LaunchpadNotFound);
});

const paths = (entries: MetadataRoute.Sitemap) => entries.map((entry) => new URL(entry.url).pathname);

test("T-031-AC-1: the sitemap lists /launch only while the launchpad is on, and / always", async () => {
  // `/` is today's home page (production main's) while the launchpad and the presale are both off.
  assert.deepEqual(paths(sitemapEntries(false)), ["/", "/privacy", "/terms"]);
  // `/` shows the presale.
  assert.deepEqual(paths(sitemapEntries(false)), ["/", "/privacy", "/terms"]);
  // With the launchpad on, the base's sitemap whatever the presale flag.
  assert.deepEqual(paths(sitemapEntries(true)), ["/", "/launch", "/privacy", "/terms"]);
  // The route reads the launchpad flag each time it renders (the presale flag is unset in this process).
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    const listed = paths(await withLaunchpadFlag(flag, async () => sitemap()));
    assert.equal(listed.some((path) => LAUNCHPAD_LINK.test(path)), false, `flag=${flag}: ${listed.join(",")}`);
    assert.deepEqual(listed, ["/", "/privacy", "/terms"], `flag=${flag}`);
  }
  assert.deepEqual(paths(await withLaunchpadFlag("true", async () => sitemap())), ["/", "/launch", "/privacy", "/terms"]);
});

test("the sitemap and robots.txt read the site origin the same way: both CDN-cached for an hour", async () => {
  assert.equal(sitemapModule.revalidate, 3600);
  assert.equal(robotsModule.revalidate, sitemapModule.revalidate);
  const entries = await withLaunchpadFlag("true", async () => sitemap());
  const origin = new URL(entries[0]!.url).origin;
  const rules = robots();
  assert.equal(rules.sitemap, `${origin}/sitemap.xml`);
  assert.equal(rules.host, origin);
  for (const entry of entries) assert.equal(new URL(entry.url).origin, origin);
});

test("launched: BLAST_LAUNCHPAD_ENABLED=team shows the launchpad to everyone and the sitemap lists it, as \"true\"", async () => {
  const page = (await withLaunchpadFlag("team", async () => NotFound())) as ReactElement;
  assert.equal(page.type, LaunchpadShell);
  assert.deepEqual(
    paths(await withLaunchpadFlag("team", async () => sitemap())),
    paths(await withLaunchpadFlag("true", async () => sitemap())),
  );
});

test("with the launchpad and the presale off, the home rewrite's page answers as production main's /: canonical / and its share URL", async (t: TestContext) => {
  const { generateMetadata } = await import("./(mission-control)/mission/page");
  t.after(() => setRequestCookie(null));
  setRequestHeaders({ "x-blast-home-rewrite": "1" });
  const home = await generateMetadata({ searchParams: Promise.resolve({}) });
  assert.equal(home.alternates?.canonical, "/");
  assert.equal(new URL(String(home.openGraph?.url)).pathname, "/");
  setRequestHeaders({});
  const entry = await generateMetadata({ searchParams: Promise.resolve({}) });
  assert.equal(entry.alternates?.canonical, "/mission");
  assert.equal(new URL(String(entry.openGraph?.url)).pathname, "/mission");
});
