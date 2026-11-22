# Reach — public web, Reddit, GitHub and YouTube reader

Core module (`sense` layer), inspired by [Agent Reach](https://github.com/Panniantong/agent-reach) (MIT). Gives crew seats a single read-only CLI (`company/tools/reach.js`) to search and read public internet sources — including Reddit posts, subreddits, and top comments — without API keys, browser logins, proxies, or anti-bot bypasses.

## Channels

| Channel | Actions | Backend(s) | Notes |
|---|---|---|---|
| `reddit` | `search`, `subreddit`, `read` | Exa public web index (`site:reddit.com/r/...`), Jina Reader fallback | Read-only; no login or API key needed; supports `--tsv` compact digests |
| `web` | `search`, `read` | Exa semantic search, Jina Reader (`r.jina.ai`) + Exa fallback | Rejects challenge/CAPTCHA/login walls honestly |
| `github` | `search`, `read` | GitHub public REST API (`api.github.com`) | Repos, READMEs, issues and pull requests |
| `youtube` | `search`, `read` | Exa `site:youtube.com/watch` + YouTube public oEmbed | Video discovery and metadata |

## Usage

```bash
node company/tools/reach.js channels
node company/tools/reach.js reddit subreddit <name> [--query "..."] [--limit 5] [--tsv] [--json]
node company/tools/reach.js reddit search "<query>" [--subreddit <name>] [--limit 5] [--tsv] [--json]
node company/tools/reach.js reddit read <reddit-url-or-id> [--json]
node company/tools/reach.js web search "<query>" [--limit 5] [--tsv] [--json]
node company/tools/reach.js web read <https-url> [--json]
node company/tools/reach.js github search "<query>" [--limit 5] [--tsv] [--json]
node company/tools/reach.js github read <owner/repo|github-url> [--json]
node company/tools/reach.js youtube search "<query>" [--limit 5] [--tsv] [--json]
node company/tools/reach.js youtube read <youtube-url> [--json]
node company/tools/reach.js read <url> [--json]
```

## Safety and Governance

- **Read-only only:** Never posts, votes, logs in, reads cookies, or solves CAPTCHAs/challenges. Challenge or login walls return a structured `CHALLENGE_OR_LOGIN_REQUIRED` error.
- **Closed by default:** `limits/limits.json` ships with all numeric caps at `0`. After enabling the module (`module.js enable reach --by owner`), open caps with `module.js limits reach set limits.json <key> <n> --by owner` (or `POST /api/ops/modules/reach/limits`).
- **External gate + SSRF guard:** Every outbound request passes `external-gate.js` (`category: "network"`) and rejects non-HTTP(S), loopback, private RFC1918, and link-local targets.
- **Metered & untrusted:** Every query appends a summary row to `company/state/reach-log.jsonl` (recorded via `provenance.js`), and all returned content carries `"untrusted": true` so downstream seats treat scraped text strictly as untrusted data.
