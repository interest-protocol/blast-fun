# Live market probe

Holds market streams open against a deployed site and logs, per frame, receipt time minus
the chain time the frame carries (`timestamp_ms`; `as_of_ms` for display prices). It is the
"before" number for the real-time work and is rerun on the direct socket.

```sh
node apps/web/scripts/live-probe/run.mjs --host us-east --minutes 1440 > samples.jsonl 2> summary.log
node apps/web/scripts/live-probe/run.mjs --mode socket --pool blast_curve:0x… > samples.jsonl
```

- Pools default to the first four pool keys on the home page; pass `--pool` to choose.
- Run on an NTP-synced host (the first stderr line says `ntp_synced`). Run one in the US and
  one in Europe.
- `--mode socket` uses the direct socket (ticket route + `wss://live.blast.fun`).
- `kind: "prices"` lags are against the price's own `as_of_ms`, not a checkpoint; read
  `market:trade` for chain-to-screen.
- Hop stamps in `provenance` (`*_ms`) are logged as offsets from the chain time.

Load: one stream per two pools per host. Tests: `npm run test:live-probe -w @blast/web`.
