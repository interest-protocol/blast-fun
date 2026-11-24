import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { Progress } from "@base-ui/react/progress";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { Select } from "@base-ui/react/select";
import { Switch } from "@base-ui/react/switch";
import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import { useSortable } from "@dnd-kit/react/sortable";
import clsx from "clsx";
import { AnimatePresence, motion, useAnimate } from "motion/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { Virtuoso } from "react-virtuoso";
import { Toaster } from "sonner";
import { createStore, useStore } from "zustand";

import { DragDropProvider } from "./DragDropProvider";
import { LibraryProviders } from "./LibraryProviders";
import { usePortalContainer } from "./portal";
import { ClientOnly, useHydrated } from "./use-hydrated";

/**
 * What each OA-28 library writes into the server's HTML
 * (`docs/product/social-feed/ui-libraries.md`). The site's CSP refuses every
 * `style="…"` there, and every `<style>` without the request's nonce, and
 * hydration never writes either again. So each pattern the guide prescribes
 * must leave neither; the traps it warns about are pinned here too, so a
 * library upgrade that changes them shows up. The browser half of the proof
 * is `scripts/ui-libraries-csp-check.ts`.
 */

const NONCE = "uiLibrariesTestNonce0123456789abcdef";

const html = (node: ReactNode) => renderToString(node);
const withProviders = (node: ReactNode) => html(<LibraryProviders nonce={NONCE}>{node}</LibraryProviders>);
const styleAttributes = (markup: string) => [...markup.matchAll(/\sstyle="([^"]*)"/g)].map((match) => match[1]!);
const styleTags = (markup: string) => [...markup.matchAll(/<style\b[^>]*>/g)].map((match) => match[0]);

/** No inline style, and every `<style>` (if any) carries the nonce. */
function assertCspClean(markup: string): void {
  assert.deepEqual(styleAttributes(markup), [], markup.slice(0, 400));
  for (const tag of styleTags(markup)) assert.match(tag, new RegExp(`nonce="${NONCE}"`), tag);
}

const libraryCss = readFileSync(fileURLToPath(new URL("./library-csp.css", import.meta.url)), "utf8");

test("OA-28 base-ui: Dialog, Menu, Popover and Tooltip put only their trigger in the server's HTML, even open", () => {
  const markup = withProviders(
    <>
      <Dialog.Root defaultOpen>
        <Dialog.Trigger>Open</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup aria-label="Dialog test">Dialog body</Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <Menu.Root defaultOpen>
        <Menu.Trigger>Menu</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner>
            <Menu.Popup>
              <Menu.Item>Item</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Popover.Root defaultOpen>
        <Popover.Trigger>Popover</Popover.Trigger>
        <Popover.Portal keepMounted>
          <Popover.Positioner>
            <Popover.Popup>Popover body</Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger>Tip</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Positioner>
              <Tooltip.Popup>Tip body</Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    </>,
  );
  assertCspClean(markup);
  assert.equal(styleTags(markup).length, 0);
  for (const body of ["Dialog body", "Item", "Popover body", "Tip body"]) assert.ok(!markup.includes(body), body);
  assert.equal([...markup.matchAll(/<button\b/g)].length, 4);
});

test("OA-28 base-ui: under LibraryProviders a ScrollArea writes no <style>; library-csp.css holds the rule it would have", () => {
  const area = (
    <ScrollArea.Root>
      <ScrollArea.Viewport>Long list</ScrollArea.Viewport>
    </ScrollArea.Root>
  );
  const bare = html(area);
  // Without the provider it renders a hoisted <style precedence>; React drops a nonce from those in
  // server HTML (Next passes only a script nonce), so the CSP would refuse it.
  const rule = /<style data-precedence="base-ui:low" data-href="base-ui-disable-scrollbar">([^<]*)<\/style>/.exec(bare);
  assert.ok(rule, bare);
  const wired = withProviders(area);
  assert.equal(styleTags(wired).length, 0);
  assert.match(wired, /class="base-ui-disable-scrollbar"/);
  const squash = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "").replace(/;}/g, "}");
  for (const declaration of rule[1]!.split("}").filter(Boolean)) assert.ok(squash(libraryCss).includes(`${squash(declaration)}}`), declaration);
});

test("OA-28 base-ui traps: ScrollArea, Switch, Select and Progress write inline styles on the server, which CSS must repeat", () => {
  const scroll = withProviders(
    <ScrollArea.Root>
      <ScrollArea.Viewport>Long list</ScrollArea.Viewport>
    </ScrollArea.Root>,
  );
  // The guide: the ScrollArea's CSS module repeats these (position: relative on the root, overflow: scroll on the viewport).
  assert.deepEqual(styleAttributes(scroll), ["position:relative;--scroll-area-corner-height:0px;--scroll-area-corner-width:0px", "overflow:scroll"]);

  const hidden = "clip-path:inset(50%);overflow:hidden;white-space:nowrap;border:0;padding:0;width:1px;height:1px;margin:0;position:fixed;top:0;left:0";
  const controls = withProviders(
    <>
      <Switch.Root>
        <Switch.Thumb />
      </Switch.Root>
      <Select.Root items={[{ label: "Live", value: "live" }]}>
        <Select.Trigger>
          <Select.Value />
        </Select.Trigger>
      </Select.Root>
      <Progress.Root value={40}>
        <Progress.Track>
          <Progress.Indicator />
        </Progress.Track>
      </Progress.Root>
    </>,
  );
  // The hidden native inputs and Progress's screen-reader "x"; library-csp.css hides each by selector.
  assert.match(controls, new RegExp(`<input [^>]*style="${hidden.replace(/[()]/g, "\\$&")}" tabindex="-1" type="checkbox" aria-hidden="true"`));
  assert.match(controls, new RegExp(`<input [^>]*style="${hidden.replace(/[()]/g, "\\$&")}" tabindex="-1" aria-hidden="true"`));
  assert.match(controls, /role="progressbar"[\s\S]*<span role="presentation" style="[^"]*">x<\/span><\/div>/);
  assert.match(libraryCss, /\[data-blast-ui\] input\[aria-hidden="true"\]\[tabindex="-1"\]/);
  assert.match(libraryCss, /\[data-blast-ui\] \[role="progressbar"\] > span\[role="presentation"\]/);
  for (const declaration of ["clip-path: inset(50%)", "overflow: hidden", "white-space: nowrap", "width: 1px", "height: 1px", "margin: 0", "position: fixed"]) {
    assert.ok(libraryCss.includes(declaration), declaration);
  }
});

test("OA-28 base-ui: Tabs.Indicator's pre-hydration script carries the nonce (CSPProvider)", () => {
  const markup = withProviders(
    <Tabs.Root defaultValue="feed">
      <Tabs.List>
        <Tabs.Tab value="feed">Feed</Tabs.Tab>
        <Tabs.Tab value="presales">Presales</Tabs.Tab>
        <Tabs.Indicator renderBeforeHydration />
      </Tabs.List>
    </Tabs.Root>,
  );
  const scripts = [...markup.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(scripts.length > 0, markup);
  for (const script of scripts) assert.match(script, new RegExp(`nonce="${NONCE}"`));
});

test("OA-28 sonner: <Toaster> renders an empty, unstyled live region on the server", () => {
  const markup = withProviders(<Toaster position="bottom-right" toastOptions={{ unstyled: true }} />);
  assertCspClean(markup);
  assert.match(markup, /^<section aria-label="Notifications alt\+T" tabindex="-1" aria-live="polite"[^>]*><\/section>$/);
});

function AnimatedBox() {
  const [scope] = useAnimate<HTMLDivElement>();
  return <div className="box" ref={scope} />;
}

test("OA-28 motion: `initial` (or initial={false}) writes inline styles on the server; layout, gestures and useAnimate do not", () => {
  assert.deepEqual(styleAttributes(html(<motion.div animate={{ opacity: 1, x: 0 }} initial={{ opacity: 0, x: -10 }} />)), [
    "opacity:0;transform:translateX(-10px)",
  ]);
  assert.deepEqual(styleAttributes(html(<motion.div animate={{ opacity: 1 }} initial={false} />)), ["opacity:1"]);
  const clean = withProviders(
    <>
      <motion.div layout whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} />
      <AnimatedBox />
      <AnimatePresence mode="popLayout">
        <motion.div exit={{ opacity: 0 }} key="a" />
      </AnimatePresence>
    </>,
  );
  assertCspClean(clean);
});

test("react-virtuoso writes inline styles on the server; ClientOnly keeps the fallback CSP-clean", () => {
  const list = <Virtuoso initialItemCount={5} itemContent={(index) => <div>{index}</div>} totalCount={100} />;
  assert.ok(styleAttributes(html(list)).length > 0);
  const deferred = withProviders(<ClientOnly fallback={<ol className="rows" />}>{list}</ClientOnly>);
  assertCspClean(deferred);
  assert.equal(deferred, '<ol class="rows"></ol>');
});

function Row({ id, index }: Readonly<{ id: string; index: number }>) {
  const { ref, handleRef } = useSortable({ id, index });
  return (
    <li ref={ref}>
      <button ref={handleRef} type="button">
        {id}
      </button>
    </li>
  );
}

test("OA-28 dnd kit: a sortable list writes no style on the server (its drag styles come later, with the nonce)", () => {
  const markup = withProviders(
    <DragDropProvider>
      <ul>
        <Row id="feed" index={0} />
        <Row id="today" index={1} />
      </ul>
    </DragDropProvider>,
  );
  assertCspClean(markup);
  assert.equal(markup, '<ul><li><button type="button">feed</button></li><li><button type="button">today</button></li></ul>');
});

test("OA-28 zustand: the server (and hydration) render a store's initial state, so a per-request store is seeded with the server's data", () => {
  type Counter = { count: number; bump: () => void };
  const counter = (count: number) =>
    createStore<Counter>()((set) => ({ count, bump: () => set((state) => ({ count: state.count + 1 })) }));
  const store = counter(5);
  function Count() {
    return <b>{useStore(store, (state) => state.count)}</b>;
  }
  assert.equal(html(<Count />), "<b>5</b>");
  // A change made before rendering is not what the server shows: zustand's server snapshot is getInitialState().
  store.getState().bump();
  assert.equal(store.getState().count, 6);
  assert.equal(html(<Count />), "<b>5</b>");
});

test("OA-28 clsx: composes CSS-module classes and drops falsy ones", () => {
  const styles = { chip: "chip_x1", on: "on_x2", off: "off_x3" };
  assert.equal(clsx(styles.chip, true && styles.on, false && styles.off, null, undefined), "chip_x1 on_x2");
  assert.equal(clsx(styles.chip, { [styles.on]: false, [styles.off]: true }), "chip_x1 off_x3");
});

test("OA-28 wiring: useHydrated and usePortalContainer are false and null in the server's render", () => {
  function Probe() {
    return <i data-hydrated={String(useHydrated())} data-container={String(usePortalContainer())} />;
  }
  assert.equal(withProviders(<Probe />), '<i data-hydrated="false" data-container="null"></i>');
  assert.equal(withProviders(<ClientOnly fallback={<b>later</b>}>now</ClientOnly>), "<b>later</b>");
});
