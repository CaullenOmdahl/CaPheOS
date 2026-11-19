# security-watch fixtures

- `station-package-lock.json` — trimmed from the real station lockfile (StarNet 0.15.0, 2026-11-19): sharp 0.35.4, two of its
  platform packages (one for another OS), the transformers copies that pull sharp in, fast-uri 3.1.7, one dev-only package.
- `osv/*.json` — real OSV vulnerability records fetched from api.osv.dev on 2026-11-19 (GHSA-wq5f-xc86-pv6w: sharp/librsvg,
  the first fixture; two fast-uri advisories, one LOW and one MODERATE).
- `npm-audit.json` — real `npm audit --json --package-lock-only` of the station lockfile, 2026-11-19, trimmed.
- `kev.json`, `node-index.json`, `chrome-versions.json` — synthetic, shaped like the CISA catalog, nodejs.org/dist/index.json
  and Google's version history API (only the fields the tool reads).
