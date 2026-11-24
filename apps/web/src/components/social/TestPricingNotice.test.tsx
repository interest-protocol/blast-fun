import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TestPricingNotice } from "./TestPricingNotice.tsx";

test("the test-pricing notice identifies simulated values without changing token identity", () => {
  assert.equal(renderToStaticMarkup(<TestPricingNotice enabled={false} />), "");
  const html = renderToStaticMarkup(<TestPricingNotice enabled />);
  assert.match(html, /aria-label="Simulated TSUI pricing"/);
  assert.match(html, /1 TSUI uses SUI’s current USD price/);
  assert.match(html, /TSUI has no real value/);
  assert.match(html, /Dollar values are simulated/);
});
