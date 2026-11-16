#!/usr/bin/env python3
"""incident-open.py — open an incident row in company/work/incidents.md from a machine.

Owner: the risk seat (loops.json function `risk`; the CEO seat while nobody else holds it).

Why a program writes the row: the detectors a register usually lists are "a person who was there,
the owner, and an agent who happened to look". A register that only a person can write records
the incidents a person noticed. This writes the other ones.

What it does, in order, and nothing else:
  1. reads the probe output, keeps the `FAIL:` lines, derives a signature from them;
  2. refuses to open a second row for the same signature on the same day (it says so and
     exits 0 — a flapping check must not fill the register, but must not vanish either);
  3. inserts one row into §3 of the register, in the table's own 9-column shape, with the
     detection timestamp it was given and Sev from the §1 scale (S1 for a health failure:
     a live surface down is S1, S0 only if the money path is implicated, which this cannot
     know — so it files S1 and says it did);
  4. appends the machine record to company/work/engineering/monitoring/incidents-auto.jsonl;
  5. appends a handoff to the inbox of the seat holding the `risk` function — that is the
     notification path: the dispatcher wakes that seat on a new handoff.

Exit codes: 0 = wrote a row or a duplicate note; 3 = could not write (marker missing, file
unreadable) — it says which, and it never writes a row it cannot place in the table.
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

# Same root as company/tools/lib/company.js: the folder holding company/.
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def _read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return fallback


CONFIG = _read_json(os.path.join(ROOT, "company", "company.json"), {})
TZ = os.environ.get("CAPHEOS_TZ") or CONFIG.get("timezone") or "UTC"


def _crew():
    return (_read_json(os.path.join(ROOT, "company", "tools", "loops.json"), {}) or {}).get("agents") or {}


def _holds(seat, fn):
    legacy = {"people": "hr", "tools": "toolsOwner"}
    return isinstance(seat, dict) and (fn in (seat.get("functions") or []) or bool(seat.get(legacy.get(fn, ""), False)))


def seat_for(fn):
    """Station id of whoever holds a function, falling back to the CEO seat (mirrors lib/company.js)."""
    crew = _crew()
    for sid, seat in crew.items():
        if _holds(seat, fn):
            return sid
    for sid, seat in crew.items():
        if _holds(seat, "ceo"):
            return sid
    for sid, seat in crew.items():
        if isinstance(seat, dict) and seat.get("manager") is None:
            return sid
    return None


def name_of(sid):
    seat = _crew().get(sid) or {}
    return seat.get("name") or sid or "the risk owner"


def local_stamp():
    now = datetime.now(timezone.utc)
    if ZoneInfo is not None:
        try:
            now = now.astimezone(ZoneInfo(TZ))
        except Exception:
            pass
    return now.strftime("%Y-%m-%d %H:%M ") + TZ


ONCALL = seat_for("risk")
ONCALL_NAME = name_of(ONCALL)
ONCALL_INBOX = ((_crew().get(ONCALL) or {}).get("inbox")) or "to-%s.md" % (ONCALL or "ceo")
# INCIDENT_REGISTER / INCIDENT_HANDOFF exist so the failure path can be proven against a copy
# instead of filling the live register with a synthetic row. They are not for routine use.
REGISTER = os.environ.get("INCIDENT_REGISTER") or os.path.join(ROOT, "company", "work", "incidents.md")
MON = os.path.join(ROOT, "company", "work", "engineering", "monitoring")
AUTO_JSONL = os.path.join(MON, "incidents-auto.jsonl")
if os.environ.get("INCIDENT_REGISTER"):
    # If a drill pointed the ROW at a copy but the dedupe state stayed in the live directory, the
    # drill would refuse to file ("already open") and, worse, a real failure the same day would
    # dedupe against a record naming a different incident's row id. A drill gets its own state file beside its own register — same code, no shared memory.
    MON = os.path.dirname(os.path.abspath(REGISTER))
    AUTO_JSONL = os.path.join(MON, "incidents-auto.jsonl")
HANDOFF = os.environ.get("INCIDENT_HANDOFF") or os.path.join(ROOT, "company", "work", "handoffs", ONCALL_INBOX)
# The row goes into §3 immediately before this paragraph, so it lands inside the table.
MARKER = "**Rows kept although they are defects rather than outages, and why:**"


def fail(msg):
    print(f"incident-open: {msg}", file=sys.stderr)
    return 3


def failing_lines(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        raise SystemExit(fail(f"cannot read probe output {path}: {exc}"))
    lines = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("FAIL:")]
    return text, lines


def signature(lines):
    # The check name, not the values, so a rotating IP or latency does not look like a new
    # incident. "FAIL: api /health not ok: {...}" and "FAIL: web root HTTP 000" are two causes.
    sigs = []
    for ln in lines:
        body = ln[len("FAIL:"):].strip()
        body = body.split("—")[0].split(":")[0].strip()
        body = re.sub(r"\s+", " ", body)[:60]
        sigs.append(body)
    return "; ".join(sorted(set(sigs))) or "unknown"


def next_id(text):
    day = datetime.now().strftime("%Y-%m-%d")
    ids = re.findall(r"INC-%s-(\d{2})" % re.escape(day), text)
    return f"INC-{day}-{max([int(i) for i in ids], default=0) + 1:02d}"


def already_open_today(sig):
    if not os.path.exists(AUTO_JSONL):
        return None
    with open(AUTO_JSONL, "r", encoding="utf-8") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("signature") == sig and rec.get("day") == datetime.now().strftime("%Y-%m-%d"):
                return rec
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--detected", required=True, help="ISO-8601 UTC timestamp of detection")
    ap.add_argument("--probe-output", required=True, help="file holding the probe's stdout+stderr")
    ap.add_argument("--by", default="company/tools/health-probe.sh (scheduled)")
    args = ap.parse_args()

    os.makedirs(MON, exist_ok=True)
    text, lines = failing_lines(args.probe_output)
    if not lines:
        print("incident-open: probe output carries no FAIL: line — nothing to file")
        return 0
    # The grade follows the FAILING CHECK, not the exit code. A backup-freshness failure means no
    # live surface is down — it means the capability to recover is absent, which is the S2
    # release-integrity class in the register (§1: "a gate that prints PASS over a failed lane").
    # "HEALTH: FAIL" is the probe's OVERALL VERDICT line, not a failing check: it is retained with the
    # FAIL lines so the row shows the run's verdict, but it must not be read as a live surface down.
    # The check name is what the line talks ABOUT, not how the line starts: the retained line reads
    # "FAIL: backups: ...", so the name is "backups" only after the "FAIL:" marker is taken off —
    # testing the raw prefix never matches and grades a backup-only failure S1, the exact error this
    # branch exists to prevent.
    def check_name(ln):
        s = ln.lstrip()
        if s.startswith("FAIL:"):
            s = s[len("FAIL:"):].strip()
        return s.split(":", 1)[0].strip().lower()

    SUMMARY_CHECKS = ("health",)
    CONTROL_CHECKS = ("backups",)
    backup_lines = [ln for ln in lines if check_name(ln) in CONTROL_CHECKS]
    summary_lines = [ln for ln in lines if check_name(ln) in SUMMARY_CHECKS]
    live_lines = [ln for ln in lines if ln not in backup_lines and ln not in summary_lines]
    backup_only = bool(backup_lines) and not live_lines
    sig = signature(lines)

    prior = already_open_today(sig)
    if prior:
        with open(AUTO_JSONL, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"at": args.detected, "day": datetime.now().strftime("%Y-%m-%d"),
                                 "signature": sig, "state": "still-failing",
                                 "firstRow": prior.get("row"), "fails": lines}, ensure_ascii=False) + "\n")
        print(f"incident-open: {prior.get('row')} is already open for this signature — logged as still-failing, no new row")
        return 0

    with open(REGISTER, "r", encoding="utf-8") as fh:
        reg = fh.read()
    if MARKER not in reg:
        return fail(f"insertion marker not found in {REGISTER} — refusing to append a row outside the table")

    row_id = next_id(reg)
    stamp = local_stamp()
    detail = " · ".join(ln[len("FAIL:"):].strip() for ln in lines)[:400]
    if backup_only:
        row = (
            f"| **{row_id}** | {args.detected} (probe run at {stamp}) — **{args.by}**, no person involved | "
            f"The production database's backup capability | **Automatically filed:** the "
            f"scheduled read-only probe found that the backup control reports the recovery capability as "
            f"unproven. Failure detail: {detail} | "
            f"**S2** (T5 — release integrity: the backup control reports that recovery is unproven — the newest "
            f"on-demand backup is old and no automatic schedule is configured, while continuous archiving is "
            f"enabled but its live coverage could not be read on this run; **no live surface is down** — the live "
            f"surfaces all answered, and the grade follows the failing check, not the exit code — "
            f"**re-grade by hand on first read**) | "
            f"**{ONCALL_NAME}** (on call; fix owner named once diagnosed — a backup schedule change may be owner-gated) | **Open** — filed {stamp} | "
            f"**None observed to a user** — the live surfaces are healthy; the cost is that a restore would rest "
            f"on continuous archiving whose coverage this check could not measure | "
            f"`company/work/engineering/monitoring/last-probe.txt` (the run that filed this), "
            f"`company/work/engineering/monitoring/health-probe.log`, `company/work/handoffs/{ONCALL_INBOX}` |\n"
        )
    else:
        row = (
            f"| **{row_id}** | {args.detected} (probe run at {stamp}) — **{args.by}**, no person involved | "
            f"Live surfaces (see failure detail) | **Automatically filed:** the scheduled read-only probe returned a "
            f"failing check on a live surface. Failure detail: {detail} | "
            f"**S1** (T1 — a live surface answered wrong or not at all; S0 if the money path is the cause, which the "
            f"probe cannot tell — **re-grade by hand on first read**) | **{ONCALL_NAME}** (on call; no fix owner named until "
            f"diagnosed) | **Open** — filed {stamp} | **Unknown at filing** — a 5xx or an unreachable host may be a "
            f"customer-facing outage or a probe-side network fault; the first responder decides, and says which | "
            f"`company/work/engineering/monitoring/last-probe.txt` (the run that filed this), "
            f"`company/work/engineering/monitoring/health-probe.log`, `company/work/handoffs/{ONCALL_INBOX}` |\n"
        )
    reg = reg.replace(MARKER, row + "\n" + MARKER, 1)
    with open(REGISTER, "w", encoding="utf-8") as fh:
        fh.write(reg)

    with open(AUTO_JSONL, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"at": args.detected, "day": datetime.now().strftime("%Y-%m-%d"),
                             "signature": sig, "state": "filed", "row": row_id,
                             "fails": lines}, ensure_ascii=False) + "\n")

    with open(HANDOFF, "a", encoding="utf-8") as fh:
        if backup_only:
            sev_line = ("severity S2 by T5 — the failing check is the backup freshness control, not a live "
                        "surface; no live surface is down")
            deadline = ("next business day (S2: row + owner named + fix verified by the check that would have "
                        "caught it)")
            need = ("read the row and close the backup gap. The live surfaces are healthy, so nothing here means "
                    "an outage; no redeploy, restart or apply is wanted from this row")
        else:
            sev_line = ("severity S1 by T1 because that is what a failed health check means by the scale — "
                        "re-grade it once you know the cause")
            deadline = "same hour (T1 is S1; the CEO informed the same hour)"
            need = ("read the row and probe it by hand before acting. Do not redeploy or restart anything until "
                    "the failure is read: a probe-side network fault looks identical to an outage from here")
        fh.write(
            f"\n## {stamp} from health-probe.sh — {row_id} opened automatically\n"
            f"**Need:** {need}. The scheduled probe failed at "
            f"{args.detected}; the row is in `company/work/incidents.md` §3 as **{row_id}**, {sev_line}.\n"
            f"**Signatures:** `{sig}`\n"
            f"**Failing lines:**\n```\n" + "\n".join(lines) + "\n```\n"
            f"**Deadline:** {deadline}.\n"
            f"**Status:** OPEN — filed by the probe, not by a person\n"
            f"**Evidence:** `company/work/engineering/monitoring/last-probe.txt`, "
            f"`company/work/engineering/monitoring/health-probe.log`, `company/tools/health-probe.sh`\n"
        )
    print(f"incident-open: filed {row_id} in {REGISTER} and appended a handoff to {HANDOFF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
