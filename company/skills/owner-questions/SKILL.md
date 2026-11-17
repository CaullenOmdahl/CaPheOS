---
name: owner-questions
description: How to ask the owner something through company/tools/inbox.js so it reads like a person wrote it and gets the right control — a secure field for keys, a link for sign-ups, options for choices. Use before every owner question.
license: MIT
metadata:
  owner: company
  version: "1.0"
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
| a key, token, password | `--kind secret --name <file> [--label] [--provider "where to get it"] [--validate <station provider id>]` |
| a sign-up / a page visit | `--kind link --url https://... --action "what to do there"` |
| account details that are not secret | `--kind account --url --action --fields "username:Your username,email:Sign-in email"` |
| one of a few options | `--kind choice --options "free:Free tier,pro:Pro" --recommended free [--allow-other] [--multi]` |
| an open answer | `--kind text [--min N] [--max N] [--placeholder]` |
| a figure / a day | `--kind number --unit USD [--min] [--max]` / `--kind date [--min YYYY-MM-DD]` |
| yes or no | nothing (the default, Approve / Decline) |
| something else | `--form '{"fields":[...],"actions":[...]}'` — any mix of info, text, secret, choice, link, number, date, checkbox, and your own actions (`{"label":"Not now","verdict":"no"}`; verdicts yes, no, submit, done, couldnt, declined) |

An unsafe form (a secret asked in a text field, a non-http link, a bad secret file name) is refused with the reason.

## 3. Keys never travel in words

Never ask the owner to paste a key into a message or the live chat; the console refuses a reply that looks like one.
The console writes the key to `secrets/<name>` (mode 0600) and your answer says only "stored at secrets/<name> (N
chars, validated: yes/no)". Use it by name — `co.secret('<name>')` in a tool — under the `secrets` guardrail. Never
print, log or copy it.

## 4. The answer

The owner may answer the form, Reply in their own words, Snooze it (`inbox.js list --from <YOU>` shows "snoozed until
..."), or Discuss it with you in a live chat. The answer reaches you as an owner message that names the question id and
says it in plain words. Act on it, and record decisions in `company/work/decisions.md`.
