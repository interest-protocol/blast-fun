import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { blastWorkspaceSetupSchema } from "./blast-workspace.ts";
import { createDraftSchema, createDraftResponseSchema, createRecipientSchema } from "./create.ts";
import { DataControlsSchema, emptyWorkspace, WorkspaceSchema } from "../blast-workspace/setup.ts";
import { createSocialValidator } from "./validate.ts";

const published = createSocialValidator();

test("workspace publication preserves the published slot bound without narrowing the live model", () => {
  const setup = { ...emptyWorkspace(), desktop_slots: [null, null, null, null, null] };
  assert.equal(WorkspaceSchema.safeParse(setup).success, true);
  assert.equal(blastWorkspaceSetupSchema.safeParse(setup).success, false);
  assert.equal(published.validate("blast-workspace-setup", setup).valid, false);
});

test("workspace publication excludes the portfolio anchor accepted by the live saved model", () => {
  const setup = structuredClone(emptyWorkspace());
  const value = {
    ...setup,
    data: { ...setup.data, controls: { ...setup.data.controls, Portfolio: {
      ...setup.data.controls.Portfolio,
      navigation: { ...setup.data.controls.Portfolio.navigation, anchor: null },
    } } },
  };
  assert.equal(WorkspaceSchema.safeParse(value).success, true);
  assert.equal(blastWorkspaceSetupSchema.safeParse(value).success, false);
  assert.equal(published.validate("blast-workspace-setup", value).valid, false);
  assert.equal("layout" in blastWorkspaceSetupSchema.shape, false);
  assert.equal("layout" in WorkspaceSchema.shape, true);
});

test("Bonding remains optional in publication and retains its live default", () => {
  const { Bonding, ...controls } = emptyWorkspace().data.controls;
  assert.ok(Bonding);
  assert.equal(DataControlsSchema.parse(controls).Bonding.view, "new");
  const wireControls = blastWorkspaceSetupSchema.shape.data.shape.controls;
  assert.equal(wireControls.parse(controls).Bonding, undefined);
  const json = z.toJSONSchema(wireControls, { io: "input" });
  assert.equal(Object.hasOwn(json.properties!.Bonding as object, "default"), false);
});

test("published vesting defaults are annotations and do not loosen required buyer fields", () => {
  const recipient = z.toJSONSchema(createRecipientSchema, { io: "input" });
  const buyer = z.toJSONSchema(createDraftSchema.shape.buyer_vesting, { io: "input" });
  for (const name of ["cliff_unit", "duration_unit"]) {
    assert.equal((recipient.properties![name] as { default: string }).default, "months");
    assert.equal((buyer.properties![name] as { default: string }).default, "months");
    assert.equal(buyer.required!.includes(name), true);
    assert.equal(recipient.required!.includes(name), false);
  }
});

test("published chart and Bluefin alternatives retain their declared union forms", () => {
  const chart = blastWorkspaceSetupSchema.shape.panels.valueType.shape.coin.shape.chart;
  assert.ok(z.toJSONSchema(chart, { io: "input" }).anyOf);
  assert.ok(z.toJSONSchema(createDraftResponseSchema.shape.bluefin_options, { io: "input" }).oneOf);
  assert.equal(z.toJSONSchema(createDraftSchema.shape.decimals, { io: "input" }).type, "integer");
});

test("published and runtime Cetus tiers both reject a third position", () => {
  const schema = createDraftResponseSchema.shape.cetus_tiers;
  assert.equal(schema.safeParse({ quote: [[1, 2]] }).success, true);
  assert.equal(schema.safeParse({ quote: [[1, 2, 3]] }).success, false);
  const json = z.toJSONSchema(schema, { io: "input" });
  const tuple = (json.anyOf![0]!.additionalProperties as { items: { maxItems: number } }).items;
  assert.equal(tuple.maxItems, 2);
});
