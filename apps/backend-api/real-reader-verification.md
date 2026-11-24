# Actual Rust reader bridge

This explicit integration gate joins the real release reader to the native Bun 1.4.2 admission process and existing frontend relay. It requires a newly published Rust release fixture handoff plus explicitly provisioned disposable backend PostgreSQL and Valkey. Missing settings, hosted targets, absent data and failed checks fail the run; it never substitutes a tiny HTTP fixture or silently skips.

The outer owned harness provisions and initializes the isolated backend database on its existing bounded PostgreSQL primary, starts its128MiB Valkey, admits the combined memory budget and holds one shared VPS heavy-job lock through all child and container cleanup. The launcher does not create containers, invoke shell provisioners, select database defaults or load environment files. Production database settings are never fallback inputs.

With the real Rust fixture paused at its new handoff, the owning harness supplies:

```sh
export BLAST_BACKEND_READER_HANDOFF=/absolute/new-run/ready.json
# Provide the synthetic harness key privately as BLAST_BACKEND_READER_TEST_API_KEY.
# Provide task-owned MISSION_CONTROL_TEST_DATABASE_URL and BLAST_TEST_REDIS_URL.
bun --no-env-file scripts/verify-backend-real-reader.mjs
```

Both dependency URLs require an explicit127.0.0.1 port. PostgreSQL accepts postgres/postgresql with explicit credentials, a named isolated database and optional connect_timeout1–30; remote-host overrides are refused. Valkey accepts a plain redis URL without query/database overrides. The schema's chain fixture must already be initialized in that isolated backend database before the canonical test runs its normal web migration chain. The launcher forwards only declared local settings, PATH/HOME/TZ and handoff/key into the test. An owned empty temporary cwd and explicit --no-env-file arguments protect the test and its nested Bun forks. Node is refused as a backend runtime; no compatibility fallback remains.

The handoff requires schema version1, a unique nonce, distinct bare HTTP loopback reader/writer origins, localnet, deployment fingerprint, release binary hash and a nonempty canonical launch-curve key. Rust creates the handoff only when BLAST_READER_TEST_HANDOFF_DIR identifies a new absolute directory. The backend selects committed-markets routing while retaining the declared writer origin. Localnet provenance checks do not relabel the mainnet-only SDK deployment contract or change production configuration.

The unchanged correctness phase reads real discovery, coin and top-trader JSON/provenance, then exercises canonical partner pool and holder routes through direct admission and signed relay. Exact cached bodies match and real market data/provenance survive. Four successful partner reads consume exactly four shared minute/day allowances. A genuine synthetic JWT reaches the same reader after that budget is exhausted, without charging it or creating an account. The next partner read receives429.

The unchanged120-second mixed profile runs eight closed-loop clients: two direct partners, two relayed partners and four verified synthetic JWT users. Actual primary key authorization, Redis admission, public handlers and one declared Rust reader stay in the request path. Only the disposable fixture key/policies change to100000 in a separate capacity namespace; the original four-read proof remains untouched. Its daily count stays4, its minute count expires normally, and capacity daily charges equal partner successes; verified users add none.

Every request contributes to exact status/error/validation counts. Every200 preserves source DTO data and localnet/deployment/checkpoint provenance. Latency percentiles use a bounded2048-entry reservoir per caller class; counts, maximum and mean cover every attempt. Observed backend/relay RSS and actual Bun runtime/version are reported. No V8 heap limit or individual512MiB cgroup is claimed. The normal5second public cache stays enabled; repeated/changing observation timestamps are not exact hit/miss counters or database-cold evidence. This finite closed-loop fixture is not production default-policy capacity, WAN performance or a hosted SLO.

Setup must complete within30seconds; the measured workload is120seconds and requests have5second timeouts. Integration and launcher deadlines stay165seconds and180seconds, within the Rust handoff's300second limit. The outer supervisor must own and terminate/reap the complete process session on timeout or interruption, then verify exact owned database/container/PID cleanup. The launcher owns only its temporary cwd and does not claim to supervise arbitrary grandchildren; its180second timeout alone is insufficient cleanup evidence.

After the test and launcher-owned cleanup, continue.json is written atomically with the matching nonce/passed boolean. Any test or local cleanup failure remains passed:false. Existing continuations cannot be reused or overwritten. Rust enforces its handoff deadline, matching nonce and passed:true before continuing its normal HTTP/load/WebSocket checks. Without the hook, Rust-only verification claims no Bun bridge coverage.

Prepared code is not an executed gate. A successful acceptance must retain current Rust binary/source bindings, complete WEB source inventory, exactly one canonical native Bun test with no skips, actual120second diagnostics and verified outer cleanup. Publication: none. No hosted-readiness claim, deployment or on-chain transaction.
