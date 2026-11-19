# Who we build for

Read this before you change anything the owner sees: a console screen, a message, a card, a digest, setup text, an
alert. The improvement engine's owner-experience check (`improve-owner`) measures against it.

## The person

- Runs a small business or a side project. Has heard that AI can do work for them and bought CaPheOS to run on a spare
  computer or a small rented server.
- Comfortable with a web browser, email, online banking and phone apps.
- **Has never used a terminal and never will.** Does not know what a port, a server log, an API, a token, a CVE, a
  container, a commit or a model id is, and should never need to.
- Uses the console in a half-screen laptop window (about 1000 x 500) or on a phone (390 wide).
- Checks in a few times a day for a few minutes.

## What they want

- See what the company did today, in a few lines.
- Answer the few things only they can answer, quickly, and then get on with their day.
- Trust that it is safe and is not spending money behind their back.

## What they fear

- A bill they did not expect.
- A message they do not understand.
- Something broken that they cannot fix.
- Being asked to decide something technical.

## The rules for every word they see (explain like I'm five)

1. **A five-year-old could follow it**, or it comes with one "what this means for you" line.
2. **Short sentences, everyday words.** Say "the AI", "the crew", "a security hole in a part we use", "the web browser
   engine", "the company's computer".
3. **Every alert says three things:** what happened, whether anything is needed from them, and what the crew is doing
   about it. "A known security hole was found in a part we use (the web browser engine). The crew is updating it now;
   nothing is needed from you."
4. **Ask only real owner matters:** access, ownership, outside commitments, spending beyond the cap, and the owner
   channel. Everything else the crew decides.
5. **Every question has a sensible default** and says what happens if they skip it ("if you skip it, nothing is
   spent").
6. **Money in plain amounts** ("about $4 a month"), never in tokens or credits.
7. **Never tell them to run something.** Give a button in the console. If the button does not exist, build it.
8. **Technical detail goes under a fold** ("Technical details (for the crew)"), never in the lead.
9. **It works at 1000 x 500 and at 390 wide**: no sideways scrolling, nothing cut off, text at least 12 px, readable
   contrast.

## Words never to show them

Unless explained in the same line in plain words:

ingress, egress, API, endpoint, CVE, advisory, token, model id or any model name with a version, port, localhost,
server log, stack trace, JSON, YAML, config, env, environment variable, systemd, unit, timer, cron, daemon, process,
PID, container, Docker, image, repo, repository, branch, commit, merge, pull request, PR, diff, patch, deploy,
rollback, CI, pipeline, webhook, OAuth, SSH, sudo, CLI, terminal, shell, script, file path, any command, a setting key
with underscores, an id like `q-123456`, `fr-0001` or `hc-0012`, a percentage of a quota, "rate limit", "context
window", "tool call", "routine", "dispatcher", "station".

The code check is `company/tools/lib/owner-scope.js` `wordsProblems()` (it also catches paths, commands, flags and
model ids). If it flags a word that is really fine for this person, change the check by a pull request with the
reason; do not work around it.

## Five things they must be able to do (the walkthrough goals)

1. Set up the company for the first time, without help.
2. See what happened today.
3. Answer a card on Today.
4. Talk to someone on the crew.
5. Understand a security alert and know that nothing is needed from them.
