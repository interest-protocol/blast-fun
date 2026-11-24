# Account activity browser check

This fixture mounts the production `AccountActivity` in React Strict Mode. It
checks genuine browser `isTrusted` pointer/keyboard input, synthetic-event
rejection, idle cooldown expiry, body-free cookie transport and unmount cleanup.
The verifier intercepts only the loopback activity endpoint with its 204 contract
and blocks external requests. The real relay, gateway and PostgreSQL composition
is covered by `packages/server/src/modules/analytics/activity.integration.test.ts`.
No provider, production service or account is contacted.

Use the installed Vite and an owned agent-browser session; install nothing. From
the repository root, after the workspace memory/disk preflight:

```sh
node node_modules/vite/bin/vite.js --config apps/web/test/fixtures/analytics/activity-client/vite.config.ts
```

In a second terminal, open and inspect that server, then copy the CDP URL printed
by the last command:

```sh
agent-browser --session activity-client open http://127.0.0.1:42989
agent-browser --session activity-client snapshot -i
agent-browser --session activity-client get cdp-url
```

Run the existing Node test runner explicitly. Missing required variables fail the
check; it never silently skips. `ACTIVITY_EVIDENCE_DIR` is an absolute task output
folder. The runner opens and closes one isolated context in the owned browser,
retaining the inspected page and avoiding clock changes in other contexts.

```sh
ACTIVITY_CDP_URL='<owned browser CDP URL>' ACTIVITY_EVIDENCE_DIR='<absolute output folder>' \
  node --test --test-concurrency=1 apps/web/test/fixtures/analytics/activity-client/verify.mjs
```

Stop the exact Vite process you started, then close only the owned browser:

```sh
agent-browser --session activity-client close
```

Fake-clock controller tests cover exact 15-minute success and 30-second failure
boundaries, UTC rollover including a delayed prior-day response, and the combined
10-second token/request deadline. Mounted tests cover default-off SocialSession
wiring without another account read, settled Privy/wallet provenance, loading,
missing tokens, Strict Mode, account replacement and commit-time aborts. Those
run in the normal web unit suite.

Collection remains disabled unless the public build-time flag
`NEXT_PUBLIC_ANALYTICS_ACCOUNT_ACTIVITY_ENABLED` is exactly `true`. Next freezes
this value into the browser build. This flag is independent of the server's
private collection flag; enabling either side or changing retention/erasure policy
requires a separate activation decision under #400.

Modern Web Guidance: `detect-initial-visibility-state`. This feature uses current
visibility and `visibilitychange`, supported across the app's browser floor. It
does not measure initial background history or performance timings.
