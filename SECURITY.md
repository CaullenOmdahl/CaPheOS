# Security policy

CaPheOS runs a company: it holds credentials, spends money, and executes agents. A vulnerability here
is not a broken page.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: on the repository, **Security → Report a vulnerability**.
If that is unavailable, contact the repository owner privately through their GitHub profile.

Include: what you did, what happened, what you expected, the commit or image tag, and the impact you
believe it has. A proof of concept helps; a real secret in the report does not — describe it, do not
paste it.

**What to expect:** an acknowledgement within three business days, a triage decision within ten, and a
fix or a documented mitigation for anything confirmed. We will credit you in the fix unless you ask us
not to.

## Supported versions

CaPheOS is **pre-release**. There is no supported release yet; fixes land on `main`. Once releases
exist, this section names the supported lines.

## In scope

- authentication and session handling of the owner console;
- the external-action gate — any act that leaves the company without a clearance row;
- approval, budget and hold bypasses;
- unit install, verification, capability grants and revocation;
- path jails, secret access, and the boundary between an agent and the company's files;
- the container: read-only root, mount guard, s6 supervision, updater bridge;
- browser grants, leases, tiers and revocation;
- the desktop microVM boundary.

The threat model — including what is **not** enforced — is stated in `docs/GUARDRAILS.md` and
`docs/DEPLOY.md`. A gap that the documents already declare is a known limit, not a vulnerability; a gap
that contradicts them is a vulnerability.

## Out of scope

- model behaviour: prompt injection in content an agent reads is an expected input, handled by fences
  and gates, not a code vulnerability;
- third-party units: report to their publisher; tell us if the registry should delist one;
- misconfiguration of your own deployment (an open console port, a mounted Docker socket, secrets in
  environment variables);
- denial of service against your own instance.

## Safe harbour

Research on your own deployment, or on a copy of this repository, is welcome. Do not test against
someone else's company, and do not exfiltrate data that is not yours.
