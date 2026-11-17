---
name: owner-questions
description: How to ask the owner something through company/tools/inbox.js so it reads like a person wrote it and gets the right control — a secure field for keys, a link for sign-ups, options for choices. Use before every owner question.
license: MIT
metadata:
  owner: company
  version: "1.3"
---

# Owner questions

Only the four owner gates (money, access, ownership, commitment) reach the owner (`chain-of-command`,
`company/DECISION_RIGHTS.md`). When one does, ask it well: the owner answers on Today in the console, one card per
question.

## 1. Plain words first

`--message` is 2-4 conversational sentences: what you need, why, what happens if they say no. Everything dense —
evidence, numbers, ids, paths, alternatives — goes in `--details` (collapsed under "More detail"). `ask` prints
`warnings` when the message is missing, over 400 characters or full of jargon: fix it and ask again.

Good:

```bash
node company/tools/inbox.js ask --from <YOU> --kind secret --name pyth-api-key --label "Pyth API key" \
  --provider "pyth.network > Developers > API keys (free)" \
  --message "Could you make a free Pyth account and paste its API key here? It lets us test our main idea about commodity prices. If you say no, that idea waits and nothing else changes." \
  --details "Pyth's price stream answers 401 without a key. Grain: 200 ms gold, 50 ms WTI. Alternatives considered: ..."
```

Bad (a report with the ask buried in it, and the key would come back in a message):

```bash
node company/tools/inbox.js ask --from <YOU> --q "Access gate (gate 2), no payment, second key: a free Pyth API key. Pyth's discovery endpoint answers us anonymously ... Please paste the key in your reply."
```

## 2. The right control

| You need | Ask with |
|---|---|
| a web address (a ping URL, a webhook) | `--form` with a `url` field (`{"id":"ping","type":"url","label":"The ping URL"}`): shown in plain text, checked as https. Never a secret field: only keys, tokens and passwords are secret |
| a key, token, password | `--kind secret --name <file> [--label] [--provider "where to get it"] [--validate <station provider id>]` |
| a sign-up / a page visit | `--kind link --url https://... --action "what to do there"` |
| account details that are not secret | `--kind account --url --action --fields "username:Your username,email:Sign-in email"` |
| one of a few options | `--kind choice --options "free:Free tier,pro:Pro" --recommended free [--allow-other] [--multi]` |
| an open answer | `--kind text [--min N] [--max N] [--placeholder]` |
| a figure / a day | `--kind number --unit USD [--min] [--max]` / `--kind date [--min YYYY-MM-DD]` |
| a level on a scale (a cap, a share, a cutoff) | `--kind slider --min 70 --max 100 [--step 1] --value 95 --unit % --say "Let routines use up to {value}% of this week's Claude" [--min-label] [--max-label]` |
| yes or no | nothing (the default, Approve / Decline); say what Approve does with `--spec '{"does":"Approve switches the commitments module on"}'` (else the card says "Approve tells <you> yes") |
| something else | `--form '{"fields":[...],"actions":[...]}'` — any mix of info, text, secret, choice, link, number, date, checkbox, slider, and your own actions (`{"label":"Not now","verdict":"no"}`; verdicts yes, no, submit, done, couldnt, declined) |

An unsafe form (a secret asked in a text field, a non-http link, a bad secret file name) is refused with the reason.

A **slider** is `{id, type: "slider", label, min, max, step?, value, unit?, marks?: [{value, label}], minLabel?, maxLabel?,
say?, sayAt?}`: `value` is your suggestion (it must sit on a step), `say` is one sentence with `{value}` that the card
shows live as the owner drags it (`sayAt` gives whole sentences for particular values, e.g. the two ends), and the answer says it back in those words ("Let routines use up to 80% of this week's Claude.").
The owner can move it with the keyboard. An answer off the range or between steps is refused on the server. Use it
when the owner picks a level, not when they pick between named options (that is a choice).

## 3. One decision per question; several decisions = `--questions`

Each decision gets its own answer. When you need several (four patches to approve, a plan to pick, a key), send ONE
request with a list of questions; the owner answers each on its own, can send the ones done so far ("2 of 5 answered"),
and the request stays open until every required one is answered or the owner closes the rest (recorded as skipped):

```bash
node company/tools/inbox.js ask --from <YOU> --message "Three things for the recorder this week." \
  --questions '[{"id":"trial","prompt":"Start the free trial?"},
                {"id":"plan","prompt":"Which plan after it?","kind":"choice","spec":{"options":"free:Free,hobby:Hobby"}},
                {"id":"key","prompt":"The data service key","kind":"secret","spec":{"name":"data-api-key"},"required":false}]'
```

Each question is `{id, prompt, kind?, spec?, form?, required?}` (approve by default; any kind or a composed form). You
hear each answer as it comes ("2 of 3 answered so far…"), and at the end the whole list: which were approved, declined
or skipped. A single Approve/Decline whose text lists several decisions (1. … 2. … 3. …) is **refused** with the split
ready to paste; add `--one-decision` only when the list is evidence for one decision. Storing a key never closes a
request or a form that asks for more than the key: the key is saved, the rest stays in front of the owner.

## 4. Never ask the owner to run anything

The owner works only in the console. An ask that tells them to run a command (`patch -p1`, `node …`, `git push …`,
`systemctl …`, `daemon-reload`, `sudo …`, `npm`/`pip install …`, any command in backticks, "in your shell", "run this",
"on your side", "may I have that one command?") is refused. Route the work instead, then ask only the decision:

- **A framework file** (tracked CaPheOS code, e.g. `company/tools/*.js`): a framework request through
  `node company/tools/harness-change.js propose --kind tool --target <file> --change <the diff> --why "…" --by <YOU>`.
  Once reviewed, apply sends the framework the request with the real diff.
- **A company file only the owner may approve** (a locked tool: the pacer, the gates, the dispatcher, the watchers):
  the same `propose`. It becomes one owner question on Today with the diff; when the owner presses Approve,
  harness-change applies it (or forwards it, for a framework file). Nobody runs anything by hand.
- **A provider setting the owner approved** (today: the MiniMax endpoint): ask one approve question that names
  MiniMax and the exact address, then, as the CEO or the people seat, apply it with
  `node company/tools/providers.js set-endpoint minimax --region global|cn|custom [--base-url <url>] --by <YOU> --approval <q-id>`
  (`--dry-run` first checks the key on that endpoint and changes nothing). It goes through the station API the console
  uses, records the write so the watcher stays quiet, and updates `company.json` and the decisions log. Never edit
  `.starnet-data/workspaces/.secrets/` or `company.json` by hand: a hand edit of the key store is flagged, and the tool
  refuses to run until the owner has accepted or reverted it.
- **Anything else that needs a command run**: a handoff to the tools seat.

## 5. Keys never travel in words

Never ask the owner to paste a key into a message or the live chat; the console refuses a reply that looks like one.
The console writes the key to `secrets/<name>` (mode 0600) and your answer says only "stored at secrets/<name> (N
chars, validated: yes/no)". Use it by name — `co.secret('<name>')` in a tool — under the `secrets` guardrail. Never
print, log or copy it.

## 6. The answer

**No longer needed?** When what you asked is fixed another way or moot, take it back at once — never leave the owner a
stale question: `node company/tools/inbox.js withdraw <q-id> [--part <n>] --why "fixed by the service rerender at 18:00" --from <YOU>`.
Today hides it and shows one line, "withdrawn by <you>: <why>", under Answered today.

The owner may answer the form, Reply in their own words, Snooze it (`inbox.js list --from <YOU>` shows "snoozed until
..."), or Discuss it with you in a live chat. The answer reaches you as an owner message that names the question id and
says it in plain words. Act on it, and record decisions in `company/work/decisions.md` with
`node company/tools/decision.js add --by <you> --text "..." --why "..."` (never by hand; `decision.js amend|withdraw` to correct one).
