import assert from "node:assert/strict";
import test from "node:test";
import { PRESALE_ABORTS } from "@interest-protocol/blast-sdk/presale";
import type { SuiClientTypes } from "@mysten/sui/client";
import { presaleAbortMessage, presaleExecutionMessage } from "@blast/core/modules/presale/abort-messages.ts";

const pkg = { package_id: `0x${"a".repeat(64)}`, original_package_id: `0x${"b".repeat(64)}` };
const failure = (module: string, abortCode: string, cleverCode?: number): SuiClientTypes.ExecutionError => ({
  $kind: "MoveAbort", message: "raw trace must not reach the user",
  MoveAbort: { abortCode, location: { package: pkg.package_id, module }, ...(cleverCode === undefined ? {} : { cleverError: { errorCode: cleverCode } }) },
});

test("every SDK presale contract code has a message", () => {
  PRESALE_ABORTS.forEach((name, code) => {
    assert.ok(presaleAbortMessage(name), name);
    assert.equal(presaleExecutionMessage(failure("blast_presale", String(code)), pkg), presaleAbortMessage(name));
  });
});

test("packed clever codes, plain codes and the original package decode; unknown codes stay unknown", () => {
  const error = failure("creation_policy", "13837028994300379151", 2);
  assert.match(presaleExecutionMessage(error, pkg)!, /This coin is not allowed/);
  error.MoveAbort!.location!.package = pkg.original_package_id;
  assert.match(presaleExecutionMessage(error, pkg)!, /This coin is not allowed/);
  const foreign = failure("creation_policy", "2");
  foreign.MoveAbort!.location!.package = "0x123";
  assert.equal(presaleExecutionMessage(foreign, pkg), null);
  for (const unknown of [failure("creation_policy", "13837028994300379151"), failure("creation_policy", "999"), failure("creation_policy", "-1"), failure("creation_policy", "1", 1.5)]) {
    assert.equal(presaleExecutionMessage(unknown, pkg), null);
  }
  assert.equal(presaleExecutionMessage(error, undefined), null, "old checkpoints without a package cannot mislabel aborts");
  for (const unknown of [null, undefined, "constructor", "toString", "ENotReal", { message: "untrusted text" }]) assert.equal(presaleAbortMessage(unknown), null);
});
