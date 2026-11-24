import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";

import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";

const OPERATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$/;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

const AUTHORIZED_MARKER = Symbol("authorized-operator");

export class AuthorizedOperator {
  readonly operatorId: string;

  constructor(operatorId: string, marker: symbol) {
    if (marker !== AUTHORIZED_MARKER) {
      throw new OperatorError("OPERATOR_AUTH_FAILED");
    }
    this.operatorId = operatorId;
    Object.freeze(this);
  }
}

/**
 * The admin website (admin.blast.fun), behind its admin password. Its server
 * reaches the backend's operator routes only with the operator bearer, which
 * the backend checks before any operator route runs, so no token is checked
 * here. Its log rows name it; each change's reason names who asked.
 */
export const ADMIN_CONSOLE_OPERATOR = new AuthorizedOperator("admin-console", AUTHORIZED_MARKER);

export class OperatorAuthenticator {
  readonly #operatorId: string;
  readonly #tokenHash: string;

  constructor(input: { operatorId: string; tokenHash: string }) {
    if (
      !z.string().regex(OPERATOR_ID_PATTERN).safeParse(input.operatorId).success ||
      !z.string().regex(TOKEN_HASH_PATTERN).safeParse(input.tokenHash).success
    ) {
      throw new OperatorError("OPERATOR_AUTH_FAILED");
    }
    this.#operatorId = input.operatorId;
    this.#tokenHash = input.tokenHash;
  }

  authenticate(operatorId: string, token: string): AuthorizedOperator {
    const actualHash = createHash("sha256").update(token).digest("hex");
    const valid =
      operatorId === this.#operatorId &&
      token.length >= 32 &&
      timingSafeEqual(Buffer.from(actualHash), Buffer.from(this.#tokenHash));
    if (!valid) throw new OperatorError("OPERATOR_AUTH_FAILED");
    return new AuthorizedOperator(operatorId, AUTHORIZED_MARKER);
  }
}
