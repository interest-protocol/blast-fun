import { registerHooks } from "node:module";
import type { FeedFreshnessSource, FreshnessHint } from "../../../../src/components/social/home/feed-freshness.ts";

let source: FeedFreshnessSource = { name: "none", subscribe: () => () => undefined };
let painted: (hint: FreshnessHint) => void = () => undefined;

export function liveFreshness(): FeedFreshnessSource { return source; }
export function recordHintPainted(_surface: string, hint: FreshnessHint): void { painted(hint); }
export function installHappeningSource(next: FeedFreshnessSource, onPaint: (hint: FreshnessHint) => void = () => undefined): void {
  source = next;
  painted = onPaint;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/happening/happening-store.ts") && specifier === "../home/activity-hints") {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export {liveFreshness,recordHintPainted} from ${JSON.stringify(import.meta.url)}`)}` };
    }
    return nextResolve(specifier, context);
  },
});
