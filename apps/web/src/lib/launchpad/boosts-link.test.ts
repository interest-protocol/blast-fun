import assert from "node:assert/strict";
import test from "node:test";

import { boostsLinkUrl } from "./boosts-link.ts";

test("a production-safe configured Boosts URL becomes the direct link", () => {
  assert.equal(boostsLinkUrl("https://boosts.blast.fun"), "https://boosts.blast.fun/");
  assert.equal(
    boostsLinkUrl("https://www.blast.fun/boosts?ref=terminal"),
    "https://www.blast.fun/boosts?ref=terminal",
  );
});

test("an absent Boosts URL renders no link", () => {
  assert.equal(boostsLinkUrl(undefined), null);
  assert.equal(boostsLinkUrl(""), null);
});

// This fails if an unsafe Boosts URL parses (and renders a link), or if the
// refusal echoes the value.
test("an invalid or unsafe Boosts URL fails, naming only the variable", () => {
  for (const value of [
    "boosts.blast.fun",
    "/boosts",
    "#",
    "not a url",
    "http://boosts.blast.fun",
    "javascript:alert(1)",
    "data:text/html,boosts",
    "https://user:secret@boosts.blast.fun",
    "https://localhost:3000/boosts",
    "https://boosts.localhost",
    "https://localhost./boosts",
    "https://boosts.localhost./",
    "https://boosts/",
    "https://boosts.local/",
    "https://boosts.internal/",
    "https://boosts.corp.internal./",
    "https://127.0.0.1/boosts",
    "https://[::1]/boosts",
    "https://10.0.0.8/boosts",
    " https://boosts.blast.fun",
    "https://boosts.blast.fun ",
  ]) {
    assert.throws(
      () => boostsLinkUrl(value),
      { message: "BLAST_BOOSTS_URL must be an HTTPS URL on a public host name." },
      JSON.stringify(value),
    );
  }
});
