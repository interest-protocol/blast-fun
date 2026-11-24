import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TestPricingNotice } from "./TestPricingNotice.tsx";

test("the test-pricing notice identifies simulated values without changing token identity", () => {
  assert.equal(renderToStaticMarkup(<TestPricingNotice enabled={false} />), "");
  const html = renderToStaticMarkup(<TestPricingNotice enabled />);
  assert.match(html, /aria-label="Test pricing"/);
  assert.match(html, /1 TSUI uses SUI’s current USD price/);
  assert.match(html, /TSUI has no real value/);
  const compact = renderToStaticMarkup(<TestPricingNotice enabled compact />);
  assert.match(compact, /<button[^>]*>Test pricing<\/button>/);
  assert.doesNotMatch(compact, /uses SUI’s current USD price/);
});
