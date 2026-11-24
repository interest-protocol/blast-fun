import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorFallback } from "./ErrorFallback.tsx";

test("the page boundary shows recovery, a safe code and a support reference without exception text", () => {
  const error = Object.assign(new Error("secret database connection and wallet payload"), { digest: "render-123" });
  const html = renderToStaticMarkup(<ErrorFallback error={error} retry={() => undefined} />);
  assert.match(html, /Code: page_unavailable/);
  assert.match(html, /Reference: render-123/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-blast-ui=""/);
  assert.match(html, /Try again<\/button>/);
  assert.match(html, /<a(?=[^>]*\bhref="\/")(?=[^>]*\bdata-ui-button="")[^>]*>Return to Blast<\/a>/, "the return link is a visible shared ButtonLink");
  assert.doesNotMatch(html, /secret|database|wallet payload/);
});
