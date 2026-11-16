# tools/ is empty on purpose

Tools arrive with the filled pack. A template ships no tool and no stub: nothing here is callable, and nothing is
copied into `company/tools/` until the owner installs the pack (`node company/tools/pack.js install <id> --by owner`),
which copies the files listed in `pack.json` `tools` to `company/tools/packs/<id>/`.

Each tool you add must be listed in `pack.json` `tools` and answer `--selftest` offline with exit 0.
