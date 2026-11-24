# Shared server implementations

`@blast/server` owns the canonical partner admission/key registry, public reads,
operator handlers and neutral contracts consumed by web and the Bun backend.
It depends on `@blast/core`, never on Next.js, React or a web application import.
Private account/session routes and frontend-only composition stay in web.

Use explicit `@blast/server/<path>.ts` imports. Browser callers may import only
browser-safe contracts; database/runtime modules remain server-side. Moving a
module here does not change its auth, quota, database or cache semantics.

Run `npm run typecheck -w @blast/server`, `npm test -w @blast/server` and relevant
`npm run test:integration -w @blast/server` under the workspace memory guard.
Integration services must be disposable loopback PostgreSQL/Valkey.
