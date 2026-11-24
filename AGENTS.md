# Working in Blast

## Boundaries

- Use the Blast SDK for reads, transactions and deterministic projections.
  Contract state and completed events are authoritative.
- Keep credentials server-side and scope private records to authorized users.
  Project browser props, API responses and log fields explicitly.
  Use `NEXT_PUBLIC_*` for public configuration. Place browser assets in
  `apps/web/public/`, server-rendered assets in
  `packages/server/assets/` and generated evidence outside the source tree.
- Define backend routes with Effect HttpApi and run workers in the shared
  Effect process scope. Keep signed admission and native request bounds in
  transport. Read `node_modules/effect/AGENTS.md` before changing Effect code.
  Follow the [backend layout](apps/backend-api/README.md#source-organization)
  for contracts, handlers and Layer wiring. Import Effect modules directly.

## Before changing behavior

- **Scale.** For endpoints and calls between browsers, servers, Sui nodes and
  third parties, follow [latency and capacity](docs/architecture/latency-and-capacity.md)
  for 10,000 visible tabs. Compute display estimates in the browser and perform
  authoritative work once per committed action. Debounce input, honor freshness
  limits, and cache and coalesce shared reads. Configure concurrency limits
  through the environment. In the PR, report added browser and origin requests
  per second and state how each limit was measured or mark it as unmeasured.
- **Product.** For launch creation, discovery, ranking, creator identity or
  post-graduation UX, read the [product decisions](docs/product/grill-me-and-explainable-discovery.md).
- **UI.** For user-facing UI or CSS changes and reviews, follow the
  [web guidance](apps/web/AGENTS.md#interface-quality).
- **Database.** Before opening a code PR, run the
  [local migration rehearsal](README.md#rehearse-database-migrations) and record
  the local target and result in the PR.

Target `main`. Use the [contributor checks](README.md#check-a-change) to verify
the affected workspace.
