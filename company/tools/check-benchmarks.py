#!/usr/bin/env python3
"""Check the public model benchmark book against its own contract (docs/RANKING.md, "The public benchmark book").

    python3 company/tools/check-benchmarks.py [--book <file>] [--policy <file>]
    python3 company/tools/check-benchmarks.py --selftest

Without --book: company/work/models/model-benchmarks.json, else the framework default
company/defaults/work/models/model-benchmarks.json. Without --policy: company/model-policy.json. Paths are relative to
the company root (env CAPHEOS_ROOT, else the folder two levels above this file).

Exits 0 with a summary when every rule holds, 1 with the failures named, 2 on a usage or read error. A normal run also
checks that its own rules can fail: it breaks copies of the book in memory (a non-URL source, a missing policy model,
a silent null score, an alias pointed at the wrong model) and FAILS if any broken copy passes -- a check that cannot
fail is not a check. --selftest runs the same rules on the fixtures in company/tools/tests/fixtures/benchmarks/: the
good book must pass and every bad-*.json must fail.

The rules:
  1. every scored row carries full provenance: modelId, benchmark, unit, an http(s) source, a YYYY-MM-DD date and a
     measuredBy of independent | vendor | house | aggregator | n/a; a null score says "not published" in its unit
  2. no model x benchmark pair twice
  3. house rows (the company's own runtime) say measuredBy "house" and carry a run count as their score
  4. every model company/model-policy.json allows is covered (an alias through aliasMap)
  5. an unreadable entry names its url and what happened
  6. a contested entry names what it is about and where it stands
  7. an alias points at the id the Claude CLI's own catalog resolves it to (only where that catalog is on the machine)
Reads files only; no network. Owner: the people function.
"""
import copy
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.environ.get("CAPHEOS_ROOT") or os.path.join(HERE, "..", ".."))
BOOK = os.path.join("company", "work", "models", "model-benchmarks.json")
BOOK_DEFAULT = os.path.join("company", "defaults", "work", "models", "model-benchmarks.json")
POLICY = os.path.join("company", "model-policy.json")
FIXTURES = os.path.join(HERE, "tests", "fixtures", "benchmarks")
MEASURED_BY = {"independent", "vendor", "house", "aggregator", "n/a"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CLI_CATALOG = os.path.expanduser(os.environ.get("CLAUDE_MODEL_CATALOG") or "~/.claude/cache/model-catalog/*.json")


def cli_alias_targets():
    """What the Claude CLI resolves haiku/sonnet/opus to, read from its own catalog. {} when the catalog is not on this
    machine: rule 7 is then 'not testable here' rather than a failure."""
    files = sorted(glob.glob(CLI_CATALOG))
    if not files:
        return {}
    try:
        with open(files[-1], encoding="utf-8") as f:
            d = json.load(f)
        raw = ((d.get("catalog") or {}).get("config") or {}).get("provider_alias_targets") or {}
        # a bare id, or {"default": id, "per_provider": {...}}: the CLI uses the default target
        return {k: (v.get("default") if isinstance(v, dict) else v) for k, v in raw.items()}
    except (json.JSONDecodeError, OSError, AttributeError):
        return {}


# openrouter "free" is the free-model fallback's virtual entry (docs/FREE-MODELS.md): it resolves to a changing free model
# at each tick, so it has no public benchmark row of its own; the free models are measured by the house ranking
VIRTUAL = {("openrouter", "free")}


def policy_models(policy):
    return [m for k, p in (policy.get("allowed") or {}).items() if isinstance(p, dict) for m in p.get("models", []) if (k, m) not in VIRTUAL]


def validate(book, policy, cli_targets=None):
    errs = []
    # 1. provenance on every row
    for i, r in enumerate(book.get("rows", [])):
        tag = f"rows[{i}] {r.get('modelId')} / {r.get('benchmark')}"
        for field in ("modelId", "benchmark", "unit", "source", "date", "measuredBy"):
            if not r.get(field) and r.get(field) != 0:
                errs.append(f"{tag}: missing {field}")
        if "score" not in r:
            errs.append(f"{tag}: missing score (use null + 'not published', never omit)")
        if r.get("measuredBy") not in MEASURED_BY:
            errs.append(f"{tag}: measuredBy={r.get('measuredBy')!r} not in {sorted(MEASURED_BY)}")
        if not str(r.get("source", "")).startswith("http"):
            errs.append(f"{tag}: source is not an http(s) URL")
        if not DATE_RE.match(str(r.get("date", ""))):
            errs.append(f"{tag}: date {r.get('date')!r} is not YYYY-MM-DD")
        if r.get("score") is None and "not published" not in str(r.get("unit", "")).lower():
            errs.append(f"{tag}: score is null but unit does not say 'not published'")
    # 2. no duplicate model x benchmark
    seen = set()
    for r in book.get("rows", []):
        k = (r.get("modelId"), r.get("benchmark"))
        if k in seen:
            errs.append(f"duplicate row for {k}")
        seen.add(k)
    # 3. house rows
    for i, h in enumerate(book.get("house", [])):
        if h.get("measuredBy") != "house":
            errs.append(f"house[{i}] {h.get('modelId')}: measuredBy must be 'house'")
        if not isinstance(h.get("score"), int) or isinstance(h.get("score"), bool):
            errs.append(f"house[{i}] {h.get('modelId')}: score must be a run count")
    # 4. every allowed model covered
    amap = {k: v for k, v in (book.get("aliasMap") or {}).items() if not k.startswith("_")}
    covered = {r.get("modelId") for r in book.get("rows", [])} | {h.get("modelId") for h in book.get("house", [])}
    for m in policy_models(policy):
        if amap.get(m, m) not in covered:
            errs.append(f"policy model {m!r} has no row in the book")
    # 7. an alias points where the CLI resolves it
    for alias, target in amap.items():
        real = (cli_targets or {}).get(alias)
        if real and target != real:
            errs.append(f"alias {alias!r} points at {target!r} but the Claude CLI catalog resolves it to {real!r}")
    # 5. unreadable entries name a result
    for u in book.get("unreadable", []):
        if not u.get("url") or not u.get("result"):
            errs.append(f"unreadable entry missing url/result: {u}")
    # 6. contested entries name their state
    for c in book.get("contested", []):
        if not c.get("state") or not c.get("about"):
            errs.append(f"contested entry missing about/state: {c}")
    return errs


def mutations(book, policy, cli):
    """broken copies of a passing book; each must be rejected. Returns the names of the ones that passed."""
    passed = []
    rows = book.get("rows", [])
    if rows:
        b = copy.deepcopy(book); b["rows"][0]["source"] = "not-a-url"
        if not validate(b, policy, cli): passed.append("bad source URL")
        b = copy.deepcopy(book); b["rows"][0]["score"] = None; b["rows"][0]["unit"] = "index points"
        if not validate(b, policy, cli): passed.append("silent null score")
        b = copy.deepcopy(book); b["rows"].append(copy.deepcopy(rows[0]))
        if not validate(b, policy, cli): passed.append("duplicate row")
    models = policy_models(policy)
    if models:
        amap = book.get("aliasMap") or {}
        gone = amap.get(models[0], models[0])
        b = copy.deepcopy(book)
        b["rows"] = [r for r in b.get("rows", []) if r.get("modelId") != gone]
        b["house"] = [h for h in b.get("house", []) if h.get("modelId") != gone]
        if not validate(b, policy, cli): passed.append("policy model missing")
    if cli:
        alias = next((a for a in (book.get("aliasMap") or {}) if a in cli), None)
        if alias:
            b = copy.deepcopy(book); b["aliasMap"][alias] = "not-the-model-the-cli-serves"
            if not validate(b, policy, cli): passed.append("alias -> wrong id")
    return passed


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def selftest():
    bad = 0
    def ok(name, cond, detail=""):
        nonlocal bad
        print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  [" + str(detail)[:300] + "]"))
        if not cond:
            bad += 1
    policy = load(os.path.join(FIXTURES, "policy.json"))
    good = load(os.path.join(FIXTURES, "good.json"))
    errs = validate(good, policy, {})
    ok("the positive fixture passes", not errs, errs)
    ok("every in-memory mutation of it is rejected", not mutations(good, policy, {"haiku": "claude-haiku-5-5"}), mutations(good, policy, {"haiku": "claude-haiku-5-5"}))
    bads = sorted(glob.glob(os.path.join(FIXTURES, "bad-*.json")))
    ok("there is at least one negative fixture", len(bads) >= 1, bads)
    for f in bads:
        case = load(f)
        errs = validate(case["book"], policy, case.get("cliTargets") or {})
        want = case.get("expect", "")
        ok("negative fixture " + os.path.basename(f) + " fails" + (" (" + want + ")" if want else ""), bool(errs) and (not want or any(want in e for e in errs)), errs)
    ok("the shipped default book passes against the shipped policy", not validate(load(os.path.join(ROOT, BOOK_DEFAULT)), load(os.path.join(ROOT, POLICY)), {}) if os.path.exists(os.path.join(ROOT, BOOK_DEFAULT)) and os.path.exists(os.path.join(ROOT, POLICY)) else True)
    print("CHECK-BENCHMARKS SELFTEST " + ("FAILED: " + str(bad) if bad else "PASSED"))
    return 1 if bad else 0


def main(argv):
    if "--selftest" in argv or (argv and argv[0] == "selftest"):
        return selftest()
    def arg(k):
        return argv[argv.index(k) + 1] if k in argv and argv.index(k) + 1 < len(argv) else None
    book_p = arg("--book") or (os.path.join(ROOT, BOOK) if os.path.exists(os.path.join(ROOT, BOOK)) else os.path.join(ROOT, BOOK_DEFAULT))
    policy_p = arg("--policy") or os.path.join(ROOT, POLICY)
    try:
        book, policy = load(book_p), load(policy_p)
    except (OSError, json.JSONDecodeError) as e:
        print(f"check-benchmarks: cannot read {e}")
        return 2
    cli = cli_alias_targets()
    errs = validate(book, policy, cli)
    rel = os.path.relpath(book_p, ROOT)
    if errs:
        print(f"FAIL -- {len(errs)} problem(s) in {rel}")
        for e in errs:
            print("  -", e)
        return 1
    print(f"PASS -- contract holds on {rel}")
    print(f"  rows={len(book.get('rows', []))} house={len(book.get('house', []))} contested={len(book.get('contested', []))} "
          f"unreadable={len(book.get('unreadable', []))} notPublished={len(book.get('notPublished', []))}")
    print(f"  policy ids covered: {len(policy_models(policy))}")
    passed = mutations(book, policy, cli)
    if passed:
        print("FAIL -- the check passed a broken copy: " + ", ".join(passed))
        return 1
    print("  broken copies (bad source, silent null, duplicate, missing policy model" + (", wrong alias" if cli else "") + "): all rejected"
          + ("" if cli else "; alias rule not testable here (no Claude CLI catalog)"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
