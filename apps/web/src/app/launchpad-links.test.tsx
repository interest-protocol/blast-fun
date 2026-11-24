import assert from "node:assert/strict";
import test from "node:test";
import type { MetadataRoute } from "next";
import { isValidElement, type ReactElement } from "react";

import { LaunchpadNotFound } from "#web/components/launchpad/LaunchpadNotFound.tsx";
import { LaunchpadShell } from "#web/components/launchpad/LaunchpadShell.tsx";
import { LaunchpadSearch } from "#web/components/launchpad/search/LaunchpadSearch.tsx";
import { installRequestHeaders } from "../../test/fixtures/lib/request-headers.testing.ts";
import { useWebConfig } from "../../test/fixtures/lib/web-config.testing.ts";

import * as robotsModule from "./robots";
import * as sitemapModule from "./sitemap";

installRequestHeaders();
const { default: NotFound } = await import("./not-found");

const sitemap = sitemapModule.default;
const robots = robotsModule.default;

const BOOSTS_URL = "https://boosts.example.com/blast";

test("the not-found page includes the launchpad shell, search, Boosts link and message", async (t) => {
  useWebConfig(t, { BLAST_BOOSTS_URL: BOOSTS_URL });
  const page = NotFound() as ReactElement<{
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

test("the public sitemap includes the launch page", () => {
  assert.deepEqual(paths(sitemap()), ["/", "/launch", "/privacy", "/terms"]);
});

test("the sitemap and robots.txt read the site origin the same way: both CDN-cached for an hour", async () => {
  assert.equal(sitemapModule.revalidate, 3600);
  assert.equal(robotsModule.revalidate, sitemapModule.revalidate);
  const entries = sitemap();
  const origin = new URL(entries[0]!.url).origin;
  const rules = robots();
  assert.equal(rules.sitemap, `${origin}/sitemap.xml`);
  assert.equal(rules.host, origin);
  for (const entry of entries) assert.equal(new URL(entry.url).origin, origin);
});

test("the mission page uses its own canonical URL", async () => {
  const { generateMetadata } = await import("./(mission-control)/mission/page");
  const entry = await generateMetadata({ searchParams: Promise.resolve({}) });
  assert.equal(entry.alternates?.canonical, "/mission");
  assert.equal(new URL(String(entry.openGraph?.url)).pathname, "/mission");
});
