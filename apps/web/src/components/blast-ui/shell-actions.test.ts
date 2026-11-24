import assert from "node:assert/strict";
import test from "node:test";

import { shortcutFor } from "./nav.ts";

const key = (value: string, modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...modifiers,
});

test("the shell opens Search with / and leaves B and F alone", () => {
  const body = { tagName: "BODY" };
  assert.equal(shortcutFor(key("/"), body, false), "openSearch");
  assert.equal(shortcutFor(key("/"), null, false), "openSearch");
  const shiftedSlash = { ...key("/"), shiftKey: true };
  assert.equal(shortcutFor(shiftedSlash, body, false), "openSearch");
  for (const value of ["b", "B", "f", "F"]) assert.equal(shortcutFor(key(value), body, false), null);
  assert.equal(shortcutFor(key("Escape"), body, false), null);
});

test("the Search shortcut ignores fields, dialogs and modified or handled events", () => {
  const body = { tagName: "BODY" };
  for (const tagName of ["INPUT", "textarea", "SELECT"]) assert.equal(shortcutFor(key("/"), { tagName }, false), null, tagName);
  assert.equal(shortcutFor(key("/"), { tagName: "DIV", isContentEditable: true }, false), null);
  assert.equal(shortcutFor(key("/"), body, true), null);
  for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const) assert.equal(shortcutFor(key("/", { [modifier]: true }), body, false), null);
  for (const flag of ["isComposing", "repeat", "defaultPrevented"] as const) {
    assert.equal(shortcutFor({ ...key("/"), [flag]: true }, body, false), null);
  }
});
