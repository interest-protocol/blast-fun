import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DataTable } from "./DataTable";

type Point = Readonly<{ time: string; price: string; change: string }>;

const points: Point[] = [
  { time: "10:00 UTC", price: "0.002410 SUI", change: "—" },
  { time: "12:00 UTC", price: "0.003120 SUI", change: "+29.5%" },
];

test("a data table has a caption, column headers, and a header for each row", () => {
  const html = renderToStaticMarkup(
    <DataTable
      caption="HELMET price every 2 hours"
      rows={points}
      rowKey={(point) => point.time}
      columns={[
        { header: "Time", cell: (point) => point.time },
        { header: "Price", numeric: true, cell: (point) => point.price },
        { header: "Change", numeric: true, cell: (point) => point.change },
      ]}
    />,
  );
  assert.match(html, /<caption[^>]*>HELMET price every 2 hours<\/caption>/);
  assert.equal(html.match(/<th scope="col"/g)?.length, 3);
  assert.equal(html.match(/<th scope="row"[^>]*>(10|12):00 UTC<\/th>/g)?.length, 2);
  assert.equal(html.match(/<td data-numeric="true"/g)?.length, 4);
});

test("a chart's table equivalent can keep its caption visually hidden but still named", () => {
  const html = renderToStaticMarkup(
    <DataTable
      caption="HELMET price every 2 hours"
      captionHidden
      rows={points}
      rowKey={(point) => point.time}
      columns={[{ header: "Time", cell: (point) => point.time }]}
    />,
  );
  assert.match(html, /<caption id="([^"]+)" class="srOnly">HELMET price every 2 hours<\/caption>/);
  const captionId = html.match(/<caption id="([^"]+)"/)?.[1];
  assert.match(html, new RegExp(`role="region" aria-labelledby="${captionId}" tabindex="0"`));
});

test("a row anchor gives each row its fragment id and marks only the linked row current", () => {
  const html = renderToStaticMarkup(
    <DataTable
      caption="HELMET price every 2 hours"
      rows={points}
      rowKey={(point) => point.time}
      rowAnchor={(point) => ({ id: `point-${point.time.slice(0, 2)}`, current: point.time.startsWith("12") })}
      columns={[{ header: "Time", cell: (point) => point.time }]}
    />,
  );
  assert.match(html, /<tr id="point-10"><th/);
  assert.match(html, /<tr id="point-12" aria-current="true"><th/);
  assert.equal(html.match(/aria-current/g)?.length, 1);
  // Without one, rows carry neither.
  const plain = renderToStaticMarkup(
    <DataTable caption="HELMET" rows={points} rowKey={(point) => point.time} columns={[{ header: "Time", cell: (point) => point.time }]} />,
  );
  assert.doesNotMatch(plain, /<tr id=|aria-current/);
});
