export type OperatorErrorCode =
  | "OPERATOR_AUTH_FAILED"
  | "OPERATOR_CONFLICT"
  | "OPERATOR_INPUT_INVALID"
  | "OPERATOR_TARGET_NOT_FOUND"
  | "OPERATOR_UNAVAILABLE";

const MESSAGES: Readonly<Record<OperatorErrorCode, string>> = {
  OPERATOR_AUTH_FAILED: "Operator authentication failed.",
  OPERATOR_CONFLICT: "The requested operator action conflicts with current state.",
  OPERATOR_INPUT_INVALID: "The operator action is invalid or outside its bounds.",
  OPERATOR_TARGET_NOT_FOUND: "The operator action target was not found.",
  OPERATOR_UNAVAILABLE: "The operator procedure is unavailable.",
};

export class OperatorError extends Error {
  readonly code: OperatorErrorCode;

  constructor(code: OperatorErrorCode) {
    super(MESSAGES[code]);
    this.name = "OperatorError";
    this.code = code;
  }
}
