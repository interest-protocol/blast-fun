import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { coverShell } from "../blast-mode-shell";

test("exit restores page scroll and a useful local focus target when the opener disappears", () => {
  const dom = new JSDOM(
    '<div><main id="main"><div id="view"><h1>Presales</h1><button id="opener">Open</button></div></main></div>',
    { url: "https://blast.test/presale" },
  );
  try {
    const { document } = dom.window;
    document.getElementById("opener")!.focus();
    document.getElementById("main")!.scrollTop = 144;
    const calls: number[][] = [];
    dom.window.scrollTo = (x: unknown, y?: number) => {
      calls.push([Number(x), y ?? 0]);
    };
    const uncover = coverShell(document);
    document.getElementById("opener")!.remove();
    document.getElementById("main")!.scrollTop = 0;
    uncover();
    assert.equal(document.activeElement?.id, "main");
    assert.equal(document.getElementById("main")!.scrollTop, 144);
    assert.deepEqual(calls, [[0, 0]]);
  } finally {
    dom.window.close();
  }
});

test("while Blast mode covers the page, everything beside it is inert except announcers and toasts; exit restores them (audit 29)", () => {
  const dom = new JSDOM(
    '<div id="root"><div id="shell"><nav id="rail"><a href="/">Home</a></nav><main id="main"><button id="opener">Open</button></main></div><section id="host"><button>Exit</button></section></div>'
      + '<aside id="banner">Test pricing</aside><section id="toasts" aria-label="Notifications alt+T"></section><div id="announcer" aria-live="polite"></div>',
    { url: "https://blast.test/@kai" },
  );
  try {
    const { document } = dom.window;
    const inert = (id: string) => Boolean((document.getElementById(id) as HTMLElement & { inert?: boolean }).inert);
    document.getElementById("opener")!.focus();
    const uncover = coverShell(document, null, document.getElementById("host"));
    assert.equal(inert("shell"), true, "the page's shell, its rail included");
    assert.equal(inert("banner"), true, "a body-level banner outside the shell");
    assert.equal(inert("host"), false, "the mode itself");
    assert.equal(inert("toasts"), false, "toasts stay reachable for the mode's own actions");
    assert.equal(inert("announcer"), false, "announcements stay live");
    uncover();
    for (const id of ["shell", "banner", "toasts", "announcer"]) assert.equal(inert(id), false, `${id} is restored`);
    assert.equal(document.activeElement?.id, "opener");
  } finally {
    dom.window.close();
  }
});
