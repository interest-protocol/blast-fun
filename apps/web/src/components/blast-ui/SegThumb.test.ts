import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { placeSegThumb, revealSegSelection } from "./seg-thumb-placement.ts";

/**
 * A `.seg` as the only thing `placeSegThumb` reads of it: the thumb it must
 * move, and the pressed button it must land on.
 */
function fakeSeg(pressed: Readonly<{ offsetWidth: number; offsetLeft: number }> | null) {
  const style: Record<string, string> = {};
  const thumb = { style };
  const seg = { querySelector: (selector: string) => (selector === ".seg-ind" ? thumb : pressed) };
  return { seg: seg as unknown as HTMLElement, style };
}

test("R3-03: the thumb lands exactly on its button, not 3px to its left", () => {
  /*
   * `.seg` pads 3px and `.seg-ind` is positioned from the same padding edge
   * (`left: 0`), so `offsetLeft` already carries that inset: the first button
   * of a 3px-padded control reports 3. The prototype subtracted the padding a
   * second time (`offsetLeft - 3`), which put every thumb in the app 3px to
   * the left of its button; the R3 reference fixed it to `offsetLeft`.
   */
  const first = fakeSeg({ offsetWidth: 74, offsetLeft: 3 });
  placeSegThumb(first.seg);
  assert.equal(first.style.transform, "translateX(3px)");
  assert.notEqual(first.style.transform, "translateX(0px)", "the old, broken placement");
  assert.equal(first.style.width, "74px", "the thumb takes its button's width");

  const third = fakeSeg({ offsetWidth: 61, offsetLeft: 160 });
  placeSegThumb(third.seg);
  assert.equal(third.style.transform, "translateX(160px)");
  assert.equal(third.style.width, "61px");
});

test("R3-03: a control with nothing pressed hides its thumb, and no control at all is left alone", () => {
  const empty = fakeSeg(null);
  placeSegThumb(empty.seg);
  assert.deepEqual(empty.style, { visibility: "hidden", transform: "" });
  assert.doesNotThrow(() => placeSegThumb(null));
});

for (const attribute of ["aria-pressed", "aria-selected"]) {
  test(`the thumb follows a ${attribute} control with real DOM selectors`, () => {
    const role = attribute === "aria-selected" ? ' role="tab"' : "";
    const dom = new JSDOM(`<div class="seg"><button${role} ${attribute}="false">First</button><button${role} ${attribute}="true">Second</button><span class="seg-ind"></span></div>`);
    try {
      const seg = dom.window.document.querySelector<HTMLElement>(".seg")!;
      const selected = seg.querySelectorAll("button")[1]!;
      Object.defineProperties(selected, { offsetWidth: { value: 80 }, offsetLeft: { value: 83 } });
      placeSegThumb(seg);
      const thumb = seg.querySelector<HTMLElement>(".seg-ind")!;
      assert.equal(thumb.style.width, "80px");
      assert.equal(thumb.style.transform, "translateX(83px)");
    } finally {
      dom.window.close();
    }
  });
}

test("aria-selected on a non-tab button leaves the thumb alone", () => {
  const dom = new JSDOM('<div class="seg"><button aria-selected="true">Selected</button><span class="seg-ind"></span></div>');
  try {
    const seg = dom.window.document.querySelector<HTMLElement>(".seg")!;
    placeSegThumb(seg);
    const thumb = seg.querySelector<HTMLElement>(".seg-ind")!;
    assert.equal(thumb.style.width, "");
    assert.equal(thumb.style.transform, "");
  } finally {
    dom.window.close();
  }
});

test("a row too narrow for its labels scrolls its selected segment into view, and a row that fits never scrolls", () => {
  const row = (scrollWidth: number, pressed: { offsetLeft: number; offsetWidth: number }) =>
    ({ scrollWidth, clientWidth: 268, scrollLeft: 0, querySelector: () => pressed }) as unknown as HTMLElement & { scrollLeft: number };
  const tight = row(344, { offsetLeft: 271, offsetWidth: 70 });
  revealSegSelection(tight);
  assert.equal(tight.scrollLeft, 271 + 70 - 268 + 3, "the last segment ends 3px inside the row");
  const back = row(344, { offsetLeft: 3, offsetWidth: 51 });
  back.scrollLeft = 76;
  revealSegSelection(back);
  assert.equal(back.scrollLeft, 0, "the first segment returns to the start");
  const fits = row(268, { offsetLeft: 200, offsetWidth: 60 });
  revealSegSelection(fits);
  assert.equal(fits.scrollLeft, 0);
});
