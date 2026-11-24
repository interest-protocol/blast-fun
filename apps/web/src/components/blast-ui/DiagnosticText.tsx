import { splitDiagnostic } from "#web/lib/errors.ts";

/**
 * An error as people read it: the sentence, then its code (`Code:
 * launch_failed.`) on a quieter line of its own (`.err-code`). Every error
 * shown carries one, so a report can be matched to its cause (docs/errors.md).
 */
export function DiagnosticText({ message }: Readonly<{ message: string }>) {
  const { text, detail } = splitDiagnostic(message);
  return <>{text}{detail !== null ? <span className="err-code">{` ${detail}`}</span> : null}</>;
}

/**
 * Under a title that already says what failed (a draft that couldn't load):
 * only the code line (`Code: …. Reference: ….`) when the sentence is the
 * screen's `generic` one, which would repeat the title (TS-2); a sentence that
 * says more (the account could not load, a code's own copy) stays above it.
 */
export function DiagnosticCode({ message, generic }: Readonly<{ message: string; generic: string }>) {
  const { text, detail } = splitDiagnostic(message);
  if (text && text !== generic) return <DiagnosticText message={message} />;
  return detail !== null ? <span className="err-code">{detail}</span> : null;
}
