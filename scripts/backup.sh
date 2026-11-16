#!/usr/bin/env bash
# backup.sh — snapshot a running company's own state (the parts git ignores) with digests, and restore it.
#
#   scripts/backup.sh                     # write a snapshot to the backup dir
#   scripts/backup.sh list                # snapshots, newest last
#   scripts/backup.sh verify [<snap>]     # check every file against its digest (default: newest)
#   scripts/backup.sh restore <snap> [--force]   # put a snapshot back (refuses over live state without --force)
#   scripts/backup.sh prune [N]           # keep the newest N (default 48)
#
# What is in a snapshot: company/work, company/state, company/owner, company/hiring, company/roles/*.md,
# company/console (panels the crew added), company/*.jsonl, company/projects.json, company/mandates.json,
# company/company.json, company/tools/loops.json. NOT secrets/, NOT the station (.starnet-data) and NOT the StarNet
# checkout. Backup dir: $CAPHEOS_BACKUP_DIR, else ~/.local/share/capheos-backups/<slug>/. Each snapshot is
# <UTC stamp>.tar.gz plus <stamp>.sha256 (one digest per file inside, sha256sum format) and the archive's own digest.
# Run it hourly from a timer if you like:  systemd-run --user --on-calendar=hourly <repo>/scripts/backup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SLUG="$(node -e "process.stdout.write(String(require('./company/company.json').slug||'company'))")"
DIR="${CAPHEOS_BACKUP_DIR:-$HOME/.local/share/capheos-backups/$SLUG}"
mkdir -p "$DIR"; chmod 700 "$DIR"

paths() {
  for p in company/work company/state company/owner company/hiring company/console company/projects.json \
           company/mandates.json company/company.json company/tools/loops.json; do [[ -e "$p" ]] && echo "$p"; done
  ls company/roles/*.md company/*.jsonl 2>/dev/null || true
}
newest() { ls -1 "$DIR"/*.tar.gz 2>/dev/null | sort | tail -1; }
snap_of() { local s="$1"; [[ -f "$s" ]] && { echo "$s"; return; }; [[ -f "$DIR/$s" ]] && { echo "$DIR/$s"; return; }; [[ -f "$DIR/$s.tar.gz" ]] && { echo "$DIR/$s.tar.gz"; return; }; echo "no snapshot $s in $DIR" >&2; exit 2; }

verify() {
  local tgz="$1" base="${1%.tar.gz}" tmp
  [[ -f "$base.sha256" ]] || { echo "FAIL no digest file for $(basename "$tgz")"; return 1; }
  grep -q "  ARCHIVE$" "$base.sha256" && [[ "$(sha256sum "$tgz" | cut -d' ' -f1)" == "$(grep '  ARCHIVE$' "$base.sha256" | cut -d' ' -f1)" ]] \
    || { echo "FAIL archive digest mismatch: $(basename "$tgz")"; return 1; }
  tmp="$(mktemp -d)"; tar -xzf "$tgz" -C "$tmp"
  ( cd "$tmp" && grep -v '  ARCHIVE$' "$base.sha256" | sha256sum --quiet -c - ) || { rm -rf "$tmp"; echo "FAIL file digests: $(basename "$tgz")"; return 1; }
  rm -rf "$tmp"; echo "ok $(basename "$tgz") ($(grep -vc '  ARCHIVE$' "$base.sha256") files)"
}

case "${1:-backup}" in
  backup)
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"; n=0; while [[ -e "$DIR/$stamp.tar.gz" ]]; do n=$((n+1)); stamp="$(date -u +%Y%m%dT%H%M%SZ)_$n"; done; out="$DIR/$stamp"
    mapfile -t P < <(paths)
    [[ ${#P[@]} -gt 0 ]] || { echo "nothing to back up (not founded?)"; exit 1; }
    tar -czf "$out.tar.gz" "${P[@]}"
    { find "${P[@]}" -type f -print0 | sort -z | xargs -0 sha256sum; echo "$(sha256sum "$out.tar.gz" | cut -d' ' -f1)  ARCHIVE"; } > "$out.sha256"
    chmod 600 "$out.tar.gz" "$out.sha256"
    verify "$out.tar.gz" >/dev/null && echo "backup $out.tar.gz ($(du -h "$out.tar.gz" | cut -f1))" ;;
  list) ls -1 "$DIR"/*.tar.gz 2>/dev/null | sort | while read -r f; do echo "$(basename "$f" .tar.gz)  $(du -h "$f" | cut -f1)"; done ;;
  verify) verify "$(snap_of "${2:-$(newest)}")" ;;
  restore)
    [[ -n "${2:-}" ]] || { echo "restore <snapshot> [--force]"; exit 2; }
    tgz="$(snap_of "$2")"; verify "$tgz" >/dev/null || { echo "refusing: $(basename "$tgz") does not verify"; exit 1; }
    if [[ "${3:-}" != "--force" && -n "$(ls -A company/work 2>/dev/null | grep -v '^.gitkeep$' || true)" ]]; then
      echo "company/work is not empty; this replaces it. Halt the company first (node company/tools/halt.js soft --by <owner>), then rerun with --force."; exit 1
    fi
    tmpx="$(mktemp -d)"; tar -xzf "$tgz" -C "$tmpx"   # read it before taking the safety copy, so nothing can replace it
    "$0" backup >/dev/null && echo "current state saved first: $(basename "$(newest)")"
    # the snapshot is the whole truth for the folders it holds: replace them, don't merge into them
    for d in work state owner hiring console; do [[ -d "$tmpx/company/$d" ]] && rm -rf "company/$d"; done
    cp -a "$tmpx/." "$ROOT/" && rm -rf "$tmpx" && echo "restored $(basename "$tgz")" ;;
  prune) keep="${2:-48}"; ls -1 "$DIR"/*.tar.gz 2>/dev/null | sort | head -n -"$keep" | while read -r f; do rm -f "$f" "${f%.tar.gz}.sha256"; done; "$0" list | tail -3 ;;
  *) sed -n 2,14p "$0"; exit 2 ;;
esac
