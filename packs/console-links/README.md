# console-links

**What it does.** Link the owner to the right place in the owner console from any message, answer, handoff or report, with ordinary markdown links in the console: scheme. Use whenever you tell the owner about something they can see, approve or change in the 

**What it needs.** Nothing: no network, no files outside its own folder, no secrets, no other unit.

**What it may touch.** Nothing. It only provides a skill through the `skills` service.

**How it runs.** `host/index.js` is a Cordis plugin (`apply`, `inject: ['skills']`). On the current stack the compat host
(`runtime/src/compat-host.mjs`) runs it and `company/tools/skills.js` pushes the skill to the seats; the new backend
loads the same plugin directly.

**How to remove it.** `node company/tools/unit.js disable console-links --by owner`. The skill leaves the company's list.
