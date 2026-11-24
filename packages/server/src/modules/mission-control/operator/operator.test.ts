import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AuthorizedOperator, OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";

const TOKEN = "operator-test-token-that-is-at-least-32-characters";
function errorCode(error: unknown): string | undefined {
  return error instanceof OperatorError ? error.code : undefined;
}

test("operator authentication uses the configured token hash", () => {
  const authenticator = new OperatorAuthenticator({
    operatorId: "ops@example.com",
    tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
  });
  assert.ok(authenticator.authenticate("ops@example.com", TOKEN) instanceof AuthorizedOperator);
  assert.throws(
    () => authenticator.authenticate("ops@example.com", `${TOKEN}-wrong`),
    (error) => errorCode(error) === "OPERATOR_AUTH_FAILED",
  );
  assert.throws(
    () => new AuthorizedOperator("spoofed", Symbol("spoofed")),
    (error) => errorCode(error) === "OPERATOR_AUTH_FAILED",
  );
});
