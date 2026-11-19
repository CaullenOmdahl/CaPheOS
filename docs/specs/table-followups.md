# Follow-ups for branch table-huddle (owner, 2026-11-19)

## 1. Meeting/huddle model + thinking pin (owner: "Imagine doing this on Fable Max? EXPENSIVE.")
- Setting under Meeting › More and in the huddle: "How hard they think": Light / Normal / Deep (+ Max only when picked deliberately).
  - Default Normal (medium) for every turn, whatever level the seat's own work uses.
  - Hand checks and leader calls always run at Light.
- Model: "each person's usual" (default) or one pinned model for everyone.
  - A pin still passes the pacer, subscription stops, the $0 cap and admit (STARNET_OVERRIDE_ALLOW / override-allow.json).
  - An unavailable pinned model means the person sits the turn out with a plain note. Never escalate to a pricier model.
- Cost line: an estimate per round at the current setting, plus a running total for the meeting.
- Owner-only setting; agents cannot change it.

## 2. Never hard-stop a turn mid-way (owner: "We also don't want to hard stop anyone during the meeting, or its wasted tokens")
- Stop = "stop after this turn". The current speaker finishes; queued turns, hand checks and the round are cancelled.
  - Only a company hard halt aborts mid-turn.
- Owner raising a hand: the floor comes after the current speaker, never cutting them off.
- Limits (8 replies per owner message, ask/hand/invite caps, idle close, dismissals) apply only between turns.
  - An agent's DISMISS of someone mid-turn takes effect after that person's turn.
- Turn timeout: keep length limits in the prompt and talk-only hand checks short.
  - Replace the 15-minute abort with a soft nudge plus a much higher safety ceiling, which only ends a run that has stalled with no output.
- Budget or pacer limits reached mid-turn let the turn finish; the next turn is held.
- Remove "Esc twice = Stop" as an abort; Esc raises a hand only.

## 3. Stay in the room, never draft ahead (owner, 2026-11-19)
Owner: "they don't start drafting a reply until it's their turn, and then they can draft a reply built on the culmination of the previous turns". Drafting early makes the meeting regress: people re-answer a question someone already answered.
- No draft-ahead.
- Each seat gets one run per meeting with a station "wait for my turn" tool (station patch). It returns everything said since the seat last spoke, and the seat writes only then, keeping its own earlier reasoning.
  - Use the 1-hour prompt cache.
  - First check that MiniMax and DeepSeek keep their reasoning across tool calls; fall back to fresh turns for any family that doesn't.
- Turn note: "Since you last spoke: … Questions already answered: … Reply to where the discussion is now: build on or disagree with the latest; do not re-answer."
- Hand checks stay as the per-exchange moment when everyone takes in what was said (Light thinking).
