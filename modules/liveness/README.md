# liveness — dead-man's switch

Layer: Guarantee. Enable when you promise coverage or availability:
`node company/tools/module.js enable liveness --by owner`.

- **Heartbeat.** `tick.js` (`runWhenHalted: true`) runs in every dispatcher tick, halted or not, and writes
  `company/state/heartbeat.json`.
- **Watcher.** `watch.js`, run by its own systemd user timer (`systemd/capheos-liveness.{service,timer}.in`, installed
  by `scripts/setup-station.sh` as `<station>-liveness.timer`, every 5 min) — not the station, not the dispatcher —
  checks the heartbeat. Older than 3 dispatcher ticks (`company/work/ops/cadence.json` `dispatcherTickMin`) = an
  outage: the owner is told once through the owner channel and, when `secrets/liveness-ping-url` exists, that URL gets a
  JSON POST **through the external gate** (category `network`; put its host on `company/state/external-allowlist.txt`).
  Recovery is told once. Every alert is a row in `company/work/liveness/alerts.jsonl`.
- **Off-box heartbeat (catches a dead machine).** A dead-man check (a monitoring service that alerts when pings stop)
  goes in `secrets/liveness-heartbeat-url`, not in `liveness-ping-url`: every healthy check GETs it through the gate,
  an outage sends nothing, so the silence is the alarm, and a dead machine is caught as well. A failure to reach it is
  logged and never fails the check. `status` shows `heartbeatAt` / `heartbeatError`.
- **Each watches the other.** The watcher writes `company/state/liveness-watch.json`; the dispatcher tick alerts when
  that is older than 3 watcher intervals (after a grace period from the first beat).
- `node company/tools/liveness.js status | ping | check`. `ping` is the certification step "pinged once"
  (`onboard.js --certify`).
- Halt: keeps running (a halted company is still alive). Limits: none. External acts: the optional push only.
