import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, testEvent, setInputValue } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act, createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Button, IconButton } = await import("./Button");
const { Checkbox } = await import("./Checkbox");
const { FieldGroup, TextField } = await import("./TextField");

test("buttons keep native refs, handlers and safe form defaults; disabled and busy prevent duplicate activation", async t => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const ref = createRef<HTMLButtonElement>(); let clicks = 0, submits = 0, captures = 0;
  const render = async (loading = false, disabled = false, focusableDisabled = false) => {
    await act(async () => root.render(<form onSubmit={event => { event.preventDefault(); submits++; }}>
      <Button ref={ref} loading={loading} loadingLabel="Saving preferences" disabled={disabled} focusableDisabled={focusableDisabled} onClickCapture={() => captures++} onClick={() => clicks++}>Save preferences</Button>
    </form>));
  };
  await render();
  assert.equal(ref.current?.type, "button");
  await act(async () => ref.current!.click());
  assert.equal(clicks, 1); assert.equal(captures, 1); assert.equal(submits, 0);
  await render(true);
  assert.equal(ref.current?.disabled, true);
  assert.equal(ref.current?.getAttribute("aria-busy"), "true");
  assert.equal(container.querySelector('[role="status"]')?.getAttribute("aria-label"), "Saving preferences");
  assert.match(container.textContent!, /Save preferences/);
  await act(async () => { ref.current!.click(); ref.current!.dispatchEvent(testEvent("click")); });
  assert.equal(clicks, 1);
  await render(false, true);
  ref.current!.focus(); assert.notEqual(document.activeElement, ref.current);
  await render(false, true, true);
  ref.current!.focus(); assert.equal(document.activeElement, ref.current);
  for (const key of ["Enter", " "]) assert.equal(ref.current!.dispatchEvent(testEvent("keydown", { key })), false);
  await act(async () => ref.current!.click());
  assert.equal(clicks, 1); assert.equal(captures, 1);
  await render(); await act(async () => ref.current!.click()); assert.equal(clicks, 2);
});

test("checkbox labels toggle the native input and fields retain exact drafts and validation associations", async t => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const input = createRef<HTMLInputElement>(), checkbox = createRef<HTMLInputElement>(); let checked = false, draft = "";
  await act(async () => root.render(<>
    <label><Checkbox ref={checkbox} onChange={event => { checked = event.currentTarget.checked; }} />Show trades</label>
    <FieldGroup><span aria-hidden="true">$</span><TextField ref={input} aria-label="Amount" aria-describedby="amount-help" aria-invalid="true" inputMode="decimal" defaultValue="0.000000000000000001" onInput={event => { draft = event.currentTarget.value; }} /><Button size="xs">Max</Button></FieldGroup>
    <p id="amount-help">Review the amount</p><IconButton aria-label="Close">×</IconButton>
  </>));
  await act(async () => container.querySelector("label")!.click()); assert.equal(checked, true); assert.equal(checkbox.current!.checked, true);
  assert.equal(input.current!.value, "0.000000000000000001");
  setInputValue(input.current!, "00012.340000"); await act(async () => input.current!.dispatchEvent(testEvent("input")));
  assert.equal(draft, "00012.340000"); assert.equal(input.current!.getAttribute("aria-describedby"), "amount-help");
  assert.equal(input.current!.getAttribute("aria-invalid"), "true");
  assert.equal(container.querySelector('[aria-label="Close"]')?.tagName, "BUTTON");
});

test("shared disclosures own their chevron and keep refs, expansion and labelled or icon-only semantics", async t => {
  const { DisclosureButton } = await import("./Button");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const ref = createRef<HTMLButtonElement>(); let clicks = 0;
  await act(async () => root.render(<>
    <DisclosureButton aria-label="Chart details" iconOnly ref={ref} size="sm" aria-expanded={false} aria-controls="chart-detail" onClick={() => clicks++} />
    <DisclosureButton aria-label="Trade details" aria-expanded={true}>Details</DisclosureButton>
  </>));
  assert.equal(ref.current!.getAttribute("data-ui-icon"), "");
  assert.equal(ref.current!.getAttribute("aria-expanded"), "false");
  assert.equal(ref.current!.getAttribute("aria-controls"), "chart-detail");
  assert.equal(ref.current!.textContent, "");
  assert.ok(ref.current!.querySelector('[data-ui-chevron][aria-hidden="true"] svg'));
  await act(async () => ref.current!.click()); assert.equal(clicks, 1);
  const labelled = container.querySelector('[aria-label="Trade details"]')!;
  assert.equal(labelled.textContent, "Details");
  assert.equal(labelled.getAttribute("aria-expanded"), "true");
});

test("selects retain native labels, refs, form values and change handling with a separate decorative chevron", async t => {
  const { SelectField } = await import("./TextField");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), ref = createRef<HTMLSelectElement>(); let value = "";
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<form>
    <label htmlFor="slippage">Slippage</label>
    <SelectField ref={ref} id="slippage" name="slippage" defaultValue="50" aria-describedby="slippage-help" onChange={event => { value = event.currentTarget.value; }}>
      <option value="50">0.5%</option><option value="100">1%</option>
    </SelectField><span id="slippage-help">Allowed price movement</span>
  </form>));
  assert.equal(ref.current!.tagName, "SELECT");
  assert.equal(ref.current!.labels![0]!.textContent, "Slippage");
  assert.equal(ref.current!.getAttribute("aria-describedby"), "slippage-help");
  const wrapper = ref.current!.parentElement!;
  assert.ok(wrapper.hasAttribute("data-ui-select"));
  assert.equal(wrapper.querySelectorAll('[data-ui-chevron][aria-hidden="true"]').length, 1);
  ref.current!.value = "100";
  await act(async () => ref.current!.dispatchEvent(testEvent("change")));
  assert.equal(value, "100");
  assert.equal(new document.defaultView!.FormData(container.querySelector("form")!).get("slippage"), "100");
});

test("the switch is a native role=switch button: it toggles by click and label, names itself, and stays put when disabled", async t => {
  const { Switch } = await import("./Checkbox");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), ref = createRef<HTMLButtonElement>();
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  let checked = false, calls = 0;
  const render = async (disabled = false) => act(async () => root.render(<>
    <Switch ref={ref} aria-label="Sound" checked={checked} disabled={disabled} onCheckedChange={next => { calls++; checked = next; }} />
    <label><Switch checked={false} onCheckedChange={() => { calls++; }} />Celebrations</label>
  </>));
  await render();
  assert.equal(ref.current!.tagName, "BUTTON");
  assert.equal(ref.current!.type, "button");
  assert.equal(ref.current!.getAttribute("role"), "switch");
  assert.equal(ref.current!.getAttribute("aria-checked"), "false");
  assert.equal(ref.current!.textContent, "", "the knob is decorative");
  await act(async () => ref.current!.click());
  assert.equal(checked, true); assert.equal(calls, 1);
  await render();
  assert.equal(ref.current!.getAttribute("aria-checked"), "true");
  await act(async () => container.querySelector("label")!.click());
  assert.equal(calls, 2, "the label's text toggles its switch");
  await render(true);
  await act(async () => ref.current!.click());
  assert.equal(calls, 2); assert.equal(checked, true);
});

test("API additions stay backwards compatible: chip size, nav and picker variants, sized field groups and a persistent pager", async t => {
  const { DisclosureButton } = await import("./Button");
  const { Pager } = await import("./Pager");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  let page = 0;
  await act(async () => root.render(<>
    <Button size="chip">Blast mode</Button>
    <DisclosureButton aria-expanded={false} data-current="" leadingIcon={<svg />} variant="nav">More</DisclosureButton>
    <DisclosureButton aria-haspopup="dialog" leadingIcon={<span />} variant="picker">SUI</DisclosureButton>
    <FieldGroup size="lg"><TextField aria-label="Amount" /><Button size="xs">Max</Button></FieldGroup>
    <FieldGroup><TextField aria-label="Search" /></FieldGroup>
    <Pager what="traders" page={1} pages={1} onPage={next => { page = next; }} alwaysShow />
    <Pager what="coins" page={1} pages={1} onPage={next => { page = next; }} />
  </>));
  assert.equal(container.querySelector('[data-ui-size="chip"]')?.textContent, "Blast mode");
  const nav = container.querySelector('[data-ui-variant="nav"]')!;
  assert.equal(nav.getAttribute("data-ui-size"), "md");
  assert.ok(nav.querySelector("[data-ui-leading] svg") && nav.querySelector("[data-ui-chevron]"));
  assert.ok(container.querySelector('[data-ui-variant="picker"] [data-ui-chevron]'));
  const [sized, plain] = container.querySelectorAll("[data-ui-field]");
  assert.equal(sized!.getAttribute("data-ui-size"), "lg");
  assert.equal(plain!.hasAttribute("data-ui-size"), false, "an unsized group still follows its input");
  assert.equal(container.querySelectorAll("nav").length, 1, "one page renders nothing unless asked");
  const pager = container.querySelector('nav[aria-label="Pages of traders"]')!;
  assert.equal((pager.querySelector('[aria-label="Previous page"]') as HTMLButtonElement).disabled, true);
  assert.equal((pager.querySelector('[aria-label="Next page"]') as HTMLButtonElement).disabled, true);
  assert.equal(pager.querySelector('[aria-current="page"]')?.textContent, "1");
  assert.equal(page, 0);
});

test("System board geometry: control sizes, the nav row, field, checkbox and switch read the board's values", async () => {
  const { readFileSync } = await import("#web/test/css-design-px.ts");
  const css = readFileSync(new URL("./Controls.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // Every top-level rule written with exactly this selector, joined.
  const rule = (selector: string) => {
    const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, head]) => head!.trim() === selector).map(([, , body]) => body!);
    assert.ok(bodies.length > 0, selector);
    return bodies.join(" ");
  };
  assert.match(rule(':is(.button,.input,.fieldGroup)[data-ui-size="sm"]'), /--control-height:32px; --control-radius:9px;/);
  assert.match(rule(':is(.button,.input,.fieldGroup)[data-ui-size="chip"]'), /--control-height:36px;/);
  assert.match(rule('.button[data-ui-size="lg"]'), /--control-height:52px; --control-radius:var\(--r-button-lg\);/);
  assert.match(rule(':is(.input,.fieldGroup)[data-ui-size="lg"]'), /--control-height:44px; --control-radius:12px;/);
  assert.match(rule(".button"), /--control-pad:16px;[\s\S]*font:600 14px\/20px var\(--font\)/);
  assert.match(rule('.button[data-ui-size="sm"]'), /--control-pad:12px; font-size:13px;/);
  assert.match(rule('.button[data-ui-size="chip"]'), /--control-pad:12px;/);
  assert.match(rule('.button[data-ui-size="lg"]'), /--control-pad:22px; font-size:16px;/);
  assert.match(rule('.button[data-ui-variant="nav"]'), /--control-height:42px; --control-radius:11px; --control-pad:12px; --control-gap:12px; --control-icon:20px;/);
  assert.match(rule('.button[data-ui-variant="nav"][data-ui-size="lg"]'), /--control-height:50px; --control-radius:12px; --control-pad:10px; --control-pad-block:8px; --control-gap:10px;/);
  assert.match(rule('.button[data-ui-disclosure]:not([data-ui-icon])'), /--control-pad-start:14px; --control-pad-end:12px;/);
  assert.match(rule(".fieldGroup[data-ui-size] .input"), /align-self:stretch/, "a sized field's input fills its frame, so the frame is its touch target");
  assert.match(rule('.fieldGroup > .button:not(.iconButton)'), /--control-height:32px; --control-radius:8px; --control-pad-start:10px; --control-pad-end:10px;/);
  assert.match(rule(".checkbox"), /width:20px !important; height:20px !important;[\s\S]*box-shadow:inset 0 0 0 1.5px var\(--muted\)/);
  assert.match(rule(".switch"), /width:46px; height:28px;[\s\S]*padding:3px;/);
  assert.match(rule(".switchKnob"), /width:22px; height:22px;/);
  assert.match(rule('.switch[aria-checked="true"] > .switchKnob'), /translateX\(18px\)/);
});

test("board additions stay backwards compatible: chip segments, a plain disclosure, the icon link, touch icons and a fixed text area", async t => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { DisclosureButton, IconButtonLink } = await import("./Button");
  const { Segmented, SegmentedLinks } = await import("./Segmented");
  const { TextArea } = await import("./TextField");
  const segmented = (size?: "sm" | "md" | "chip") => renderToStaticMarkup(<Segmented label="Coin sources" onChange={() => {}} options={[["discover", "Discover"], ["following", "Following"]]} size={size} tabs value="discover" />);
  assert.match(segmented("chip"), /class="seg" data-size="chip"[^>]*role="tablist"/);
  assert.match(segmented("sm"), /data-size="sm"/);
  assert.doesNotMatch(segmented(), /data-size/, "md stays the unmarked default");
  assert.doesNotMatch(segmented("md"), /data-size/);
  assert.match(renderToStaticMarkup(<SegmentedLinks items={[{ href: "/a", label: "A", current: true }]} label="Views" size="chip" />), /class="seg" data-size="chip"/);

  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  let toggles = 0;
  await act(async () => root.render(<>
    <DisclosureButton aria-controls="filters" aria-expanded={false} chevron={false} leadingIcon={<svg />} onClick={() => toggles++} size="chip">Filters</DisclosureButton>
    <DisclosureButton aria-expanded={false} size="chip">24h</DisclosureButton>
    <IconButton aria-label="Search" size="touch"><svg /></IconButton>
    <TextArea aria-label="Bio" />
    <TextArea aria-label="Post" resize="none" />
  </>));
  const plain = container.querySelector('[aria-controls="filters"]') as HTMLButtonElement;
  assert.equal(plain.getAttribute("data-ui-disclosure"), "plain");
  assert.equal(plain.querySelector("[data-ui-chevron]"), null, "no trailing chevron");
  assert.ok(plain.querySelector("[data-ui-leading] svg"));
  assert.equal(plain.getAttribute("aria-expanded"), "false");
  await act(async () => plain.click()); assert.equal(toggles, 1);
  const chevroned = [...container.querySelectorAll("[data-ui-disclosure]")].find(node => node.textContent === "24h")!;
  assert.equal(chevroned.getAttribute("data-ui-disclosure"), "", "the default keeps its chevron");
  assert.ok(chevroned.querySelector("[data-ui-chevron]"));
  const touch = container.querySelector('[aria-label="Search"]')!;
  assert.equal(touch.tagName, "BUTTON");
  assert.equal(touch.getAttribute("data-ui-size"), "touch");
  assert.ok(touch.hasAttribute("data-ui-icon"));
  const [bio, post] = container.querySelectorAll("textarea");
  assert.equal(bio!.hasAttribute("data-ui-resize"), false, "the default resizes as before");
  assert.equal(post!.getAttribute("data-ui-resize"), "none");

  const link = renderToStaticMarkup(<IconButtonLink aria-current="page" aria-label="Notifications" href="/notifications" size="chip"><svg /></IconButtonLink>);
  assert.match(link, /^<a(?=[^>]*aria-label="Notifications")(?=[^>]*aria-current="page")(?=[^>]*class="button iconButton")(?=[^>]*data-ui-button="")(?=[^>]*data-ui-icon="")(?=[^>]*data-ui-size="chip")(?=[^>]*data-ui-variant="ghost")(?=[^>]*href="\/notifications")[^>]*><svg><\/svg><\/a>$/);
  assert.match(renderToStaticMarkup(<IconButtonLink aria-label="Back" href="/" size="touch" variant="secondary"><svg /></IconButtonLink>), /data-ui-size="touch" data-ui-variant="secondary"/);
  assert.match(renderToStaticMarkup(<IconButtonLink aria-label="Home" href="/"><svg /></IconButtonLink>), /data-ui-size="md" data-ui-variant="ghost"/);
});

test("board additions read the boards' values: chip segments 30 / 14, plain chip 15px glyph, touch 44 / 20", async () => {
  const { readFileSync } = await import("#web/test/css-design-px.ts");
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
  const controls = strip(readFileSync(new URL("./Controls.module.css", import.meta.url), "utf8"));
  const shared = strip(readFileSync(new URL("./blast-ui.css", import.meta.url), "utf8"));
  const rule = (css: string, selector: string) => {
    const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, head]) => head!.trim() === selector).map(([, , body]) => body!);
    assert.ok(bodies.length > 0, selector);
    return bodies.join(" ");
  };
  assert.match(rule(shared, '[data-blast-ui] .seg[data-size="chip"] :is(button, a)'), /height: 30px; padding: 0 14px;/);
  // The track around them keeps its 3px inset and 10px corners, so the chip row is 36px.
  assert.match(rule(shared, "[data-blast-ui] .seg"), /padding: 3px; border-radius: var\(--r-button\);/);
  assert.match(rule(controls, '.button.iconButton[data-ui-size="touch"]'), /--control-height:44px; --control-icon:20px;/);
  assert.match(rule(controls, '.button[data-ui-disclosure="plain"]:not([data-ui-icon])[data-ui-size]'), /--control-pad-end:var\(--control-pad-start\);/);
  assert.match(rule(controls, '.button[data-ui-disclosure="plain"]:not([data-ui-icon])[data-ui-size="chip"]'), /--control-icon:15px;/);
  assert.match(rule(controls, '.button[data-ui-disclosure]:not([data-ui-icon])[data-ui-size="chip"]'), /--control-pad-start:12px; --control-pad-end:12px; --control-gap:6px;/);
  assert.match(rule(controls, '.textarea[data-ui-resize="none"]'), /resize:none;/);
});
