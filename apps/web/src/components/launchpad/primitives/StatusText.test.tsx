import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StatusText } from "./StatusText";

test("a status reads its direction in words and draws its own shape", () => {
  const up = renderToStaticMarkup(<StatusText tone="up">+42.6% in 24 h</StatusText>);
  const down = renderToStaticMarkup(<StatusText tone="down">−12.1% in 24 h</StatusText>);
  assert.match(up, /data-tone="up"/);
  assert.match(up, /data-glyph="triangle-up"/);
  assert.match(up, /<span class="srOnly">Up: <\/span>\+42\.6% in 24 h/);
  assert.match(down, /data-glyph="triangle-down"/);
  assert.match(down, /<span class="srOnly">Down: <\/span>−12\.1% in 24 h/);
});
