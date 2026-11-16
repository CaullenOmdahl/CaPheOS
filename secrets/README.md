# secrets/

Keys the company's tools read, one file each, mode 0600. Everything in this folder except this README is ignored by
git. Tools read them through `company/tools/lib/company.js` (`co.secret(name)`); an environment variable
`CAPHEOS_SECRET_<NAME>` (upper case, `-` as `_`) overrides the file.

| File | What | Created by |
|---|---|---|
| `station-token` | this station's API token (per station, never shared) | `scripts/setup-station.sh` |
| `minimax-key` | MiniMax plan key (custom OpenAI-compatible endpoint) | you |
| `deepseek-key` | DeepSeek API key (vision checks; pay-per-use) | you |
| `openrouter-key` | OpenRouter key (reserve) | you |
| `openrouter-mgmt-key` | OpenRouter management key (spend gate) | you |

Provider keys may be the same ones another company on this machine uses. Two companies can share an account; set
each company's share in `company/work/finance/pacing-policy.json` so their combined use stays inside the plan.

```
install -m 600 /dev/null secrets/minimax-key && $EDITOR secrets/minimax-key
```
