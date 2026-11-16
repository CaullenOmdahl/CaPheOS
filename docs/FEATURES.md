# Feature inventory (input to the new UI)

Every feature the new CaPheOS UI must reach: the StarNet station's own (branch `feat/harness-backend`, frontend
`starnet/frontend/app/`, route table `ROUTES` in `starnet/sidecar/index.js`, ~380 unique `/api/*` paths) and the
company layer in `company/tools/`. `frontend/app/places.js` is StarNet's own map of every place in its UI.

## StarNet navigation today
- CREW: Agents (dossier Brief / Growth / Record / Memory / Config), Recruit, You, Step-in
- WORK: My work (Tasks / Deliverables / To review / Recipes), Automate (Workflows / Schedules / Goal loops / Away work), Quests (Progress), Trophy case
- BUILD: Build mode, Connect (Abilities: Apps / Connected + API keys / Tools + Computer control / Extensions / Skill market / Skills + Learned; Channels), New app
- APPS: New app, Manage apps
- SYSTEM: Field manual, Settings (AI & models / Autonomy / Permissions / Spending limits / Look & sound / Alerts / Remote / Browser / App & backup), Updates, Notifications
- Left rail: Sessions / Projects, Needs you, Crew rail. Always on: Comms, model dock, context gauge, top bar (XP, spend), widgets, HUD, cinema

## StarNet areas
| Area | What the user does | Endpoints (under /api/) |
|---|---|---|
| Station floor | watch agents, props, conveyor lines live | state/snapshot, agents/affinity, routing, line-jobs, runs, observe |
| Build mode | rooms, decks, props (props grant powers), presets, community maps, generated props | toolsets, plugins, community-maps/*, userprops/* |
| Recruit / crew | summon from a class or custom class, prospects, delete | roster, summon/ack, agent/delete, scout/*, harness/detect |
| Agent dossier | brief, growth, logbook + restore, memory, config (purpose, instructions, model, personality, access, look) | insights, runs, transcript, checkpoint/*, memory/*, agent/model, dossier, growth/* |
| You (owner) | about you, aims, preferences, agent briefing, sources, station record | dossier, goals, discovery/sources, journey, personalization |
| Comms | chat, attachments, slash commands, steer/stop, redact, retract, group DMs, delegated workers | run, run/stream, run/steer, cancel, attachments, slash/*, transcript/*, groups, subagents/* |
| Approvals | consent decks, Needs-you queue, run recovery | consent/*, run-recoveries/* |
| Sessions / projects | workstreams, bless folders, project home | projects/*, pickpath, lineage/* |
| Tasks / deliverables | kanban, finished files, cleanup/undo, rate away runs | deliverables/*, line-jobs, file |
| Recipes | one-click jobs | recipes/drift, cron/preview |
| Workflows | conveyor lines, step test, triggers, fix-suggest | line-jobs/*, routing/*, workflow-takeovers |
| Schedules | create, edit, arm, run now, history, degraded | cron, cron/{arm,run,update,remove,preview,history,degraded/clear} |
| Goal loops | start, control, verdict, test check | loops/* |
| Away work | queue, backlog, grant, keep/later/discard, morning report, focus/avoid | workshop/*, nightshift/*, away/briefing |
| Quests / trophies | quest log, confirm/dismiss, north star, battle pass | quests/*, journey |
| Learning | belief updates, threads, recommendations, discovery | study/*, threads/*, recommendations/*, discovery/* |
| Abilities | connectors + OAuth, MCP, toolset kill switches, computer control, service keys, hooks, plugins | connectors/*, toolsets/*, computer-control, servicekeys/*, hooks/*, plugins/* |
| Skills | market, library toggle, learned-skill candidates + evaluation | skills/*, skill-market/*, agent-skills/*, skill-exchange/* |
| Channels | Telegram, Discord, Slack, Matrix, Signal; owner pairing; notify; handoff | channels/* |
| Apps | describe an app and get it; rename, schedule, delete | apps/*, plugins/call |
| Browser / step-in | in-app browser, take over an agent's browser, sign-ins | browser/* |
| Providers & models | sign-ins (Claude CLI etc.), API keys, local models, model dock + effort, fallback chain, tiers | providers/*, models/:p, model-tiers, auth/*, fallback/chain |
| Usage / spend | caps, settle, resume, spend today, per-provider remaining | budget/*, usage/providers |
| Autonomy / permissions | posture dial (wait/suggest/small jobs/free), presets, per-agent grants, halt | autonomy/*, permissions/*, execution/*, halt |
| Voice | STT, TTS, local voice, live voice | stt/*, tts/*, local-voice/*, realtime/* |
| Widgets | pinned instruments | widgets/* |
| Remote | pair a phone, per-device ask-first, revoke | remote/* |
| App & backup | export/import, recovery, cloud save, erase, runtime knobs, updates, diagnostics | config/*, recovery/*, save/*, runtime/*, update/*, diagnostics, version, health |

## Company layer (no HTTP API yet: the UI needs a small company backend over these tools)
| Feature | The owner sees / does | Source |
|---|---|---|
| Dispatcher | last/next tick, who was woken and why, closed quests, spend split | dispatch.js, work/dispatch-state.json, work/dispatch-log.md, cap-numerator.js |
| Owner inbox | messages, routed recipient, acknowledgements | owner-inbox.js, owner-addressing.js, owner/*.jsonl |
| Owner questions | open gate questions with recommendation + default; answer | inbox.js, ask.js, state/owner-outbox.json |
| Escalations / mandates | blocks by class; mandates | escalate.js, mandate.js |
| Handoffs | open by deadline, overdue, archive | handoff-status.js, handoff-archive.js |
| Hiring | rounds, candidates, interviews, hire/release, seat templates, function moves | hire.js, hiring/, loops.json, roles/templates/ |
| Org / seats | who holds which function, reporting lines | loops.json |
| AI usage pacer | each plan's daily line vs used, routing plan, emergency, off-peak | pacer.js, offpeak-*.js |
| Merge gate | PR gate status, default-branch watch | merge-gate.js, premerge-check.js, default-branch-watch.js |
| External gate | clearances by category, attempt log, clear/close | external-gate.js |
| Locked files | drift, accept/revert/undo | locked-watch.js, provenance.js, connector-scope.js |
| Competence / performance | scoreboard, flags, 1-on-1 corrections | competence.js, performance.js, corrections.js |
| Latitude | own prompt sections; shared-change proposals | my-section.js, harness-change.js |
| Decisions | decisions log, decision rights | work/decisions.md |
| Projects | request / approve / revoke ownership | project.js |
| Model health | benchmarks, routine length, drift | model-stats.js, routine-length.js, model-drift.js |
| Skills HR | proposals with pre-screen; approve/reject | skills-hr.js |
| Health / incidents | probes, incidents, tool integrity | health-check.sh, incident-open.py, tool-parse.js, quest-audit.js |
