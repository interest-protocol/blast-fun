/** `term` as a `LIKE` literal: `\`, `%` and `_` escaped (the default escape character). */
export function likeLiteral(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}
