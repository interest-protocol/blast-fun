"use client";

import { useState } from "react";
import { Button, IconButton, DisclosureButton } from "../../../../../src/components/blast-ui/Button.tsx";
import { Disclosure } from "../../../../../src/components/blast-ui/Disclosure.tsx";
import { CloseIcon } from "../../../../../src/components/blast-ui/Icons.tsx";
import { Sheet, SheetClose, SheetHeading, SheetCta } from "../../../../../src/components/blast-ui/Sheet.tsx";
import { Checkbox } from "../../../../../src/components/blast-ui/Checkbox.tsx";
import { FieldGroup, TextField, TextArea, SelectField } from "../../../../../src/components/blast-ui/TextField.tsx";

/** Test-only surface for shared controls outside Blast mode's accent scope. */
export default function ControlsProof() {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  return <div data-blast-ui="" data-theme="light"><main style={{ maxWidth: 660, margin: "32px auto", padding: 16, display: "grid", gap: 16 }}>
    <h1>Shared controls</h1>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <DisclosureButton iconOnly aria-label="Icon details" aria-expanded={detailsOpen} aria-controls="control-details" onClick={() => setDetailsOpen(!detailsOpen)} />
      <DisclosureButton aria-label="Labelled details" size="sm" aria-expanded={detailsOpen} aria-controls="control-details" onClick={() => setDetailsOpen(!detailsOpen)}>Details</DisclosureButton>
      <DisclosureButton aria-label="Long details" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>Details for a very long market identity with extra explanation</DisclosureButton>
    </div>
    <p id="control-details" hidden={!detailsOpen}>Disclosure details</p>
    <Disclosure title="Shared collapsible">Disclosure body</Disclosure>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <Button variant="primary" onClick={() => setCount(count + 1)}>Buy more</Button>
      <Button>Sell</Button><Button variant="ghost">Cancel</Button><Button variant="danger">Remove</Button>
      <IconButton aria-label="Close"><CloseIcon /></IconButton><Button disabled>Unavailable</Button>
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <Button size="xs">Compact</Button><Button size="sm">Small</Button><Button size="md">Default</Button><Button size="lg">Large</Button>
    </div>
    <Button loading={busy} loadingLabel="Saving preferences" onClick={() => { setBusy(true); setCount(count + 1); }}>Save preferences</Button>
    <Button onClick={() => setBusy(false)}>Finish simulated save</Button>
    <output aria-label="Action count">{count}</output>
    <label><Checkbox defaultChecked /> Show trades</label><label><Checkbox disabled /> Following unavailable</label>
    <label htmlFor="controls-search">Search<TextField id="controls-search" aria-label="Search" type="search" placeholder="Search markets" /></label>
    <FieldGroup><span aria-hidden="true">$</span><TextField aria-label="Amount" inputMode="decimal" placeholder="0.00" /><Button size="xs">Max</Button></FieldGroup>
    <TextField aria-label="Invalid amount" aria-invalid="true" defaultValue="invalid" />
    <TextArea aria-label="Comment" placeholder="Write a comment" />
    <SelectField aria-label="Slippage"><option>0.5%</option><option>1%</option></SelectField>
    <Button onClick={() => setReviewOpen(true)}>Review example</Button>
    <Sheet open={reviewOpen} labelledBy="controls-review-heading" hasCta onRequestClose={() => setReviewOpen(false)}>
      <SheetClose onClick={() => setReviewOpen(false)} />
      <SheetHeading id="controls-review-heading" title="Review" lead="Shared component preview" />
      <p style={{ margin: 0, fontSize: 34, lineHeight: 1.2, fontWeight: 600, letterSpacing: "-.02em" }}>23.40 <span style={{ fontSize: 16, color: "var(--muted)" }}>USDC</span></p>
      <dl style={{ margin: 0, padding: 16, borderRadius: "var(--r-sm)", background: "var(--control-field)", display: "grid", gridTemplateColumns: "1fr auto", gap: 16, fontSize: 14 }}>
        <dt>Network</dt><dd style={{ margin: 0 }}>Sui</dd><dt>Network fee</dt><dd style={{ margin: 0 }}>0.002 SUI</dd>
      </dl>
      <SheetCta><Button variant="primary" size="lg" onClick={() => setReviewOpen(false)}>Done</Button></SheetCta>
    </Sheet>
  </main></div>;
}
