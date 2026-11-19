# Amendments to the self-improvement design (owner, 2026-11-19)

## A. Product, UI and UX lens: who the user is
Owner: "sometimes we get so deep in designing functionality and features and addressing edge cases and patching bugs that we forget how our target demographic, our user, if we were to monetize this and self-host it and sell this to people, how would they use it? What would they know? ... if it's just your average Joe Schmo ... Everything is going to have to be explained like I'm five. Understanding ingress and egress, API endpoints, understanding critical vulnerabilities and CVEs. They're not going to understand any of this."
- A written target-user persona: who buys and self-hosts CaPheOS, what they know, what they don't. It lives in the repo (docs/USER.md), is read by the crew and is checked on every owner-facing change.
- A UX generator: walkthroughs of real flows as that persona, done by plain-code screenshots at small windows, plus a persona review by a seat with the product hat.
  - Flows: first setup, Today, Needs you, chat, meetings, settings, a security alert.
  - Findings become items.
- Plain language as a gate on owner-facing strings: no jargon such as ingress, egress, API, endpoint, CVE, token, model id or file path. An explanation must be one a five-year-old could follow, or a "what this means for you" line.
- UX markers on the scorecard: steps to finish setup, owner asks per week, jargon hits, time to answer a card, screens that fail at 1000x500.
- Product research belongs in the weekly market research item: how competitors explain things to non-technical owners.

## B. Security watch for known vulnerabilities (CVEs), as a P0
Owner: "the CVE space recently has been absolutely crazy ... in one of our core distributions, to have the security analysts that we already have a profile for have a way to actively check open CVEs and to check if anything in the environment is affected, and to make changes as soon as possible as a P0. And then from there, if any of those changes required were to any core component, any upstream component, any component that's synced to our remote or to our repository or ties in any way, shape, or form, that it is also addressed as an issue as a P0 on our own repository for repair."
- A core module or duty that is plain code; no AI decides when it runs.
- It inventories what each company runs:
  - the CaPheOS framework and its npm and pip deps;
  - the StarNet station and its node_modules;
  - the company's own repos and lockfiles (Baarista and others);
  - the browsers (Chrome) and runtimes (Node, Python);
  - OS packages where readable;
  - container images if any.
- It checks them against public vulnerability feeds (OSV.dev, GitHub advisories) on a schedule, and immediately when the inventory changes.
- An affected match with a known fix and real reach becomes a P0 item in the security seat's inbox: Phil in CPD, Ingrid in the sandbox.
  - The item names the component, the version and the fixed version.
  - It wakes the seat at once (push).
  - Its fix goes through the normal pipeline, fast-tracked.
- When the affected component is core or upstream (the CaPheOS framework, the station, anything synced to the CaPheOS repository or tied to it), a P0 issue is also filed on the CaPheOS GitHub repo, deduplicated across companies.
- Owner-facing wording is plain: "A known security hole was found in a part we use (the web browser engine). Phil is updating it now; nothing is needed from you." The owner is asked only when a fix needs a fixed-gate decision (access, money, outside commitment).
- Outbound access goes to the vulnerability feeds only (an owner decision for the allowlist). Nothing about the company is sent except package names and versions.

## C. Owner decisions, 2026-11-19
- **CPD merges and deploys its own CaPheOS changes. APPROVED.** Owner: "I think that's incredibly important." Changes touching the four fixed owner gates or the owner channel still go to the owner.
- **Deployment without any external system.** Owner: "I don't know if we should somehow have an AB deployment or if we can figure out how to do an update in place, because we can't rely on having an external system be able to handle it."
  - Design an on-machine release switch:
    1. Each company keeps the previous good framework version.
    2. The update is staged and checked first: tests, console selftest, a dispatcher dry tick, certify.
    3. Then it is switched in place: a git checkout of the release commit, then a restart of the affected units.
    4. A local plain-code watchdog (systemd timer, no AI) watches health for a window and rolls back by itself if health fails, telling the crew and, in plain words, the owner.
  - A/B option: two framework checkouts per company with a symlink switch, if in-place proves fragile.
  - Order: sandbox first as canary, CPD after a clean window. It must be container-ready too (capheos-container-deploy).
- **DeepSeek: let it rest** until the efficiency work is installed. Owner: "I am not happy with how the DeepSeek key has been handled." Find out what went wrong with the key and credit handling (credit burn, holds, a key in the wrong place?) as part of the efficiency work.
- **Logins for X, Instagram and TikTok for the scouts: APPROVED, but they must be reliable.**
  - Dedicated company accounts, not the owner's.
  - Credentials in the secrets store.
  - A persistent logged-in browser profile in the planned sandboxed/containerized desktop, which is not built yet.
  - Read-only behaviour, with rate limits.
  - Session-health checks that re-login or file an item when a session dies.
  - Ban-risk awareness.
  - Creating an account needs the owner (phone or email verification), as a fixed access gate.
  - Until the container desktop exists: no-login sources first (Reddit, YouTube, Telegram, RSS bridges for public pages).
- **Sandbox site list:** the owner leaves it to my discretion. Keep it as is.
