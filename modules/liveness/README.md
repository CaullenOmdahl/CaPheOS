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
  goes in `secrets/liveness-heartbeat-url`. The ping is its OWN unit
  (`systemd/capheos-liveness-heartbeat.{service,timer}.in` → `<station>-liveness-heartbeat.timer`, `watch.js heartbeat`,
  state in `company/state/liveness-heartbeat.json`), separate from the dispatcher-silence watcher; a company set up
  before the split keeps pinging from the watcher until `scripts/setup-station.sh` installs and starts the new timer.
  While the dispatcher beats, every heartbeat run GETs the URL through the gate; an outage sends nothing, so the
  silence is the alarm, and a dead machine is caught as well. A failure to reach it is logged and never fails the
  check. If `liveness-ping-url` holds the same URL, the module does not send the outage push to it (logged "reported
  by silence"), so nothing has to be removed; `liveness-ping-url` is for a separate alert endpoint. `status` shows
  `heartbeatAt`, `heartbeatError` and `pingEqualsHeartbeat`.
- **Testing the outside alarm (owner only).** Settings › System › *Test the outside alarm* (`alarm-test.js`, routes in
  `http.js` behind the owner token) asks for the check's period and grace, then sets
  `company/state/liveness-heartbeat-pause.json`: the heartbeat unit skips its ping while it holds (the watcher is a
  separate unit and never paused, so dispatcher-silence alerts still fire). It shows when the alert is due (last ping + period + grace)
  and an *I got the alert* button; it resumes and pings at once when the owner clicks, or by itself 5 min after the
  alert was due: the heartbeat unit checks that deadline every run, so the pause never outlives it, console or not. Each test
  is rows in `company/work/security/heartbeat-tests.jsonl`, and its result goes to the risk seat as a handoff.
- **Each watches the other.** The watcher writes `company/state/liveness-watch.json`; the dispatcher tick alerts when
  that is older than 3 watcher intervals (after a grace period from the first beat).
- `node company/tools/liveness.js status | ping | check`. `ping` is the certification step "pinged once"
  (`onboard.js --certify`).
- Halt: keeps running (a halted company is still alive). Limits: none. External acts: the optional push only.
