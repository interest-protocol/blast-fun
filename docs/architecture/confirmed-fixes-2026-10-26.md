# Confirmed architecture corrections

The capacity target is 10,000 simultaneous users. It is not 10,000 requests per
second, a hosted capacity result, or a ratified latency SLO. Read latency,
availability and workload acceptance still need production resource and traffic
assumptions. Ingestion remains blocked pending coordinator authorization.

Current corrections retain financial assertions, evidence and quota identities:

| Area | Behavior |
| --- | --- |
| Public profile misses | Read the primary on a replica miss; open a write transaction only for an existing Mission Control member needing an account. |
| Onboarding admission | Existing IP budgets precede admission lookups. Wallet IP consumption moves instead of being duplicated. Attempt/address limits remain. |
| Share/card work | Publish consumes the existing share bucket. SSR card pages use the existing card budget and verified client identity. |
| Vesting settlement | Two active refreshes per request; failures remain isolated. Cancellation stops new refreshes and ownership waits for active work. |
| Transport | Protected coalesced dependency readiness, explicit expensive-work caps, distinct private replay socket, bounded upload allowance and accurate operational retry. Separate Redis sockets still share server Lua execution. |
| Digest ownership | First reservation requires exact transaction bytes bound to the caller's proven wallet, or authoritative executed-transaction evidence. An unknown digest alone reserves nothing. |
| Withdrawals | Missing chain evidence does not establish terminal expiry. Signing freshness is separate from reconcilable settlement. Durable request/sponsor ownership prevents duplicate results; uncertain cross-store budget consumption fails closed pending reconciliation. |
| Rust reader | Connection-local typed statement reuse, same-snapshot independent-query pipelining, request-local entity reuse and batched open candles. HTTP capacity is protected from concurrent subscription snapshots. |

Checkpoint-provider trust, durable evidence retention/recovery, decoded-memory
capacity, actual deployment configuration and measured 10,000-user capacity remain
separate acceptance requirements. No evidence history is deleted and no numerical
latency/throughput improvement is inferred from a code change alone.
