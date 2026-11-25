# Live market probe

Holds direct market sockets open against a deployed site and logs, per frame, receipt time
minus the chain time the frame carries (`timestamp_ms`; `as_of_ms` for display prices).

```sh
node apps/web/scripts/live-probe/run.mjs --host us-east --minutes 1440 > samples.jsonl 2> summary.log
node apps/web/scripts/live-probe/run.mjs --pool blast_curve:0x… > samples.jsonl
```

- Pools default to the first four pool keys on the home page; pass `--pool` to choose.
- Run on an NTP-synced host (the first stderr line says `ntp_synced`). Run one in the US and
  one in Europe.
- Each stream asks the ticket route for a ticket, then opens the socket it names
  (`wss://live.blast.fun`) with the site's `Origin`. A 204 ticket means the socket is off.
- `kind: "prices"` lags are against the price's own `as_of_ms`, not a checkpoint; read
  `market:trade` for chain-to-screen.
- Hop stamps in `provenance.hops` are logged as offsets from the chain time (`r2_put_ms` is a duration).

Load: one stream per two pools per host. Tests: `npm run test:live-probe -w @blast/web`.
