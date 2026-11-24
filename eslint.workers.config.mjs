// Use with explicit apps/workers, packages/core and scripts targets. This
// reuses every applicable repository rule without loading the web parser.
import shared from "./scripts/eslint/non-web.mjs";
export default shared;
