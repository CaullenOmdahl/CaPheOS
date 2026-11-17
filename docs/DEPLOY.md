# Deployment plan (v2)

**Source:** `deploy-plan-v2.md`, from the StarnetOS scratchpad
(`/tmp/claude-1000/-home-caullen-Projects-StarnetOS/2961f761-…/scratchpad/`), pasted by the owner on 2026-11-17.
Preserved here because that path is temporary.

**Status:** the owner's plan, written before the backend rewrite. Its names are StarNet-era (`station`,
`.starnet-data/`, `.browsers/`, `tool-inventory-check`); once the backend lands it gets the vocabulary pass in
`docs/STYLE.md` §Vocabulary. The decisions it leaves open are D1–D19 in §8. The backend design that consumes §4 and §5
is `docs/BACKEND.md` §6.5.

---

(Plan v2, pasted by the owner on 2026-11-17: "Deployable, containerized CaPheOS with browser identity, grants, and a security seat". The draft is for independent audit; this is a faithful summary.)

**§0 Risk posture.** A capability plan with a risk model. The owner is the risk authority: safe defaults, opt-in depth, opt-ins recorded.

**§1 Capabilities.** Each comes with its bounding:
- an immutable container;
- an encrypted external drive;
- s6;
- a framework manifest instead of git;
- company tools on /data;
- config three-way merge;
- a host updater bridge;
- read-only root;
- Safe Cell shell isolation;
- a desktop VM;
- a real headed browser with a clean profile;
- grants, leases and tiers;
- risk acceptance records;
- an infosec seat;
- an external dead-man;
- quiesced snapshots;
- audit rows.

**§2 Deployment:**
- **Filesystem split:**
  - /app/company/tools and /app/modules: framework tools, read-only, from the image;
  - /data/company/tools: company-only tools;
  - tool-inventory-check reads both.
- **Config three-way merge:** the base is the previous image's defaults. Tier-3 files (loops.json, dispatch-budget.json, pacing-policy.json) never auto-resolve; the owner chooses.
- **Git replaced** by a framework manifest of hashes plus version, with the previous one retained. company/repos keeps real git.
- **Storage:** btrfs/LVM on LUKS, mounted by UUID with nofail; a mount guard; a single-writer lock; a second copy. Unlock via TPM2/Clevis, then an orchestrator key, then manual with a "drive locked" state.
- **Supervision:** s6 as PID 1 running station, dispatcher-loop, a liveness loop and the console. Graceful stop = drain → soft halt → continuity → stop. Recovery via run-journal.
- **Read-only root as a P0 gate.** Relocate .starnet-data/, .browsers/, .tmp/ marketplaces, the station log, ~/.config, ~/.cache/codex-runtimes and the Chrome profile.
- **Updates:** quiesce → snapshot → new image → config merge → schema migration (downgrade refused) → /readyz + certify → rollback window. The updater bridge is a host-side service with a pin-only API (status, check, apply <tag>) and its own token; no Docker socket in the app.
- **Health:** /readyz, external dead-man, stdout-only token-free logs, retention, 4–6 GB RAM, shm_size, TZ from company.json.

**§3 Agent execution boundary.** Safe Cell isolates shell only. fs.read/write run in-process, path-jailed to the agent workspace with a reserved-path refusal (workspace-reserved.js). It still needs verifying whether /data/secrets is covered and whether scoped runs reach the company root.
- **D8:** broad access inside the company root; shell isolated; desktop isolated.
- **Mounts:** company/work and company/tools read-write into the cell; never secrets/, state/locked/ or owner dirs.
- **Desktop:** a microVM, no host mounts, no Docker socket, an egress allowlist, an ephemeral profile, no GPU passthrough without signed risk acceptance, PID/memory caps, a kill switch.

**§4 Browser and desktop:**
- Headed real Chrome, with a dedicated extension-free profile per identity. Launch without --enable-automation/--headless; a CDP attach alone doesn't set navigator.webdriver.
- STEP-IN handoff: the agent parks, the owner signs in, then hands back.
- A desktop-driver abstraction {screenshot, readTree, click, type, key, drag}. Backends: Windows CUA (present, x64-only) and Linux (XTEST/libei, AT-SPI). Never the owner's live session.
- A browser host on the owner's machine for realism; server-side, a headless Chromium sidecar.

**§5 Grants, leases, tiers:**
- **A grant** = origins, identity class, actor, capability (read/interact/transact), window, rate, expiry, renewal, profile, revocation.
- **Expiry presets:** per-session / N hours or days / until-revoked with a 30-day idle expiry / auto-renew with a ~90-day re-consent cap.
- **Tiers:**
  - 0: standing allow, logged (games, docs);
  - 1: 30-day (social);
  - 2: 7-day (GitHub write, CRM, email);
  - 3: per-session, with transact re-consent (banking, brokerage, DNS).
- **Asymmetry:** auto-escalation on payment fields, password changes or 2FA; de-escalation is owner-only. Agents never set a tier.
- **Identity classes:** personal / dedicated-agent / service.
- **Risk acceptance:** an owner-signed record per site and identity, with an expiry.
- **Enforcement:** browserAdmit({grantId, url, action}) → allow|deny|ask at the browser host.
- **Revocation:** three lists (live sessions, persistent profiles, service connections), each a real kill. Kill authority sits with the browser-host service.

**§6 Security seat:**
- Seat template; a daily sweep, post-escalation reviews and a weekly summary.
- Deterministic duties: ports, novel egress, grants, expired-but-live sessions, drift, backup/patch age.
- A conformance suite.
- Independence: a locked findings record; only the owner suppresses; the seat can't edit the gates it watches.
- The checks run even if it isn't hired. It's offered at the first Tier 2/3 grant, with a cost estimate.

**§7 Rejected:** session import, stealth spoofing, driving the owner's live desktop, in-app git pull, hard blocks.

**§8 Decisions D1–D19:**
- D1: btrfs on LUKS.
- D2: Safe Cell P0 as-is, P2 next.
- D3: Chromium baked in P0, sidecar in P2.
- D4: orchestrator plus updater bridge.
- D5: a compose project per company.
- D6: a 0600 master key file.
- D7: 30–60 s of downtime.
- D8: as in §3.
- D9: TPM2/Clevis → orchestrator → manual.
- D10: Claude subscription not recommended in a container (API keys on servers, subscription on the desktop).
- D11: API keys by default on servers.
- D12: CDP-act + STEP-IN now; driver abstraction later.
- D13: microVM desktop.
- D14: never import sessions.
- D15: consent profile (technical owner vs standard).
- D16: grants as scoped leases.
- D17: tiers 0–3.
- D18: identity classes.
- D19: risk acceptance.

**§10 Reviewer focus, to verify first:**
1. harness-change no longer patches framework files inside a company, only company-only tools.
2. Framework provenance depends on `git show HEAD:`, `git ls-files` and .git.
3. The tools/builtin/fs.js path jail, and whether its reserved paths cover /data/secrets and scoped runs.
4. Every path the station writes inside its own checkout.
5. Liveness is still timer-driven.
6. computer-control.js is Windows-x64-only, with a trycua vendor.
7. browser.js prefers headed real browsers, with no stealth flags.
8. Where the claude CLI keeps its credentials, and whether it can log in non-interactively.
9. No Docker socket is needed in the app for updates.
10. Any safety claim in §3–§5 that depends on the above.

**§11 Phasing:**
- P0: image + s6 + drive/mount guard + manifest + tool split + read-only audit + CI certify.
- P1: compose/proxy/TLS + dead-man + updater bridge + quiesced backup/restore.
- P2: Safe Cell + Chromium sidecar + grants/leases/revocation + security bundle.
- P3: desktop microVM + driver abstraction + auto-escalation + risk acceptance.
- P4: multi-company, HA optional.
