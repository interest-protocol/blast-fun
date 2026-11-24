<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Interface quality

For UI or CSS changes and reviews, use the
[Blast UI skill](../../.claude/skills/blast-ui/SKILL.md) for components, tokens,
states, the lint guard, browser captures and independent review. Read the
[design system](../../docs/design-system/BLAST-DESIGN-SYSTEM.md) for design
decisions.

For inline address and creator bylines, use
[`CopyAddress`](src/components/blast-ui/CopyAddress.tsx). Its leading icon, label,
and shortened value are one copy button with shared hover, focus, and feedback.
Copy the exact underlying wallet or coin tag. Keep profile navigation separate.
Check hover and clipboard values on both a presale and a bonding coin page.

## Navigation and state

Use Next.js links and router methods for navigation. Put shareable filters in
the URL and transient UI state in React. Use browser history state when Back
or Forward must restore something specific to that visit, such as a list’s
scroll position. Reuse [list restoration](src/components/blast-ui/list-restoration.ts)
for lists that need this behavior.

## Platform first

Reuse Blast UI primitives. For behavior they do not cover or changes to a
primitive, check platform guidance for dialogs, popovers, forms, layout,
scrolling, viewports and keyboard handling.

- Run `DISABLE_TELEMETRY=1 npx -y modern-web-guidance@1.0.0 search "<generic query>"`
  followed by `DISABLE_TELEMETRY=1 npx -y modern-web-guidance@1.0.0 retrieve "<id>"`.
  Keep the telemetry setting, use queries without project, coin or person names
  and limit commands to `search`, `retrieve` and `legacy-scan`.
- Use Baseline Widely available features. Use feature detection and a native
  fallback for Newly available features. Check Safari behavior. The browser floor is
  Chrome, Edge and Firefox 111+ and Safari 16.4+.
- Record `Modern Web Guidance: <guide ids used>` or `none` in the PR.

## Loading UI

Use shared skeletons for pending content and `LoadingIndicator` with
accessible status labels for pending actions. Verify success and failure
transitions. A successful empty read shows the empty state.
