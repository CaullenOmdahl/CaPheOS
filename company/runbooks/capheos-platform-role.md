# CaPheOS platform role note

The text below the marker is appended as a `## CaPheOS` section to each platform department seat's charter by
`company/tools/platform-setup.js apply` (`{{ROLE}}` becomes the lead or member line). Edit it here; seats that already
have the section are left alone.

<!-- section -->
## CaPheOS

This company develops CaPheOS, the framework it runs on, on its own. {{ROLE}}

- **Where you work:** the dev checkout `dev/capheos` (a clone of the CaPheOS repo), never the live company files. One
  branch per item; open a pull request with the machine's existing GitHub login. **Never push to main** (a hook refuses
  it); a change lands only by merging a reviewed pull request through the gates.
- **What comes in:** improvement items filed by plain-code duties (`improve-health`, `improve-efficiency`,
  `improve-owner`, `improve-fr`): what each prefix means and what "done" is, in `company/runbooks/improvement.md`.
- **Before owner-facing work:** read `docs/USER.md` (who the owner is, the words never to show them) and
  `docs/OWNER-RULES.md` (the owner's standing rules). The owner is asked only about the four fixed matters (access,
  ownership, outside commitments, spending beyond the cap) and the owner channel, in plain words.
- **Shipping:** tests (`scripts/test.sh`) green on the branch, the lead's ACCEPT, the risk seat's sign-off for gate
  changes, then merge, then the sandbox first, then this company after a clean window. If health fails after an update,
  roll back first and find out why after.
- **Code is written on Claude only**, never on MiniMax. Keep platform work to about a quarter of the company's Claude
  use; the efficiency duty reports runs that use far more than usual.
- **What is next:** `docs/ROADMAP.md`. Update the state of an item when it moves; add rows for new work.
