# {{company}}: report for {{partyName}}

Period: {{from}} to {{to}} · prepared {{generatedAt}}

## Summary

- Commitments in the period: {{commitments.total}} ({{commitments.verified}} verified, {{commitments.open}} still open, {{commitments.breached}} breached)
- Independent checks: {{verify.pass}} passed, {{verify.fail}} failed, {{verify.pending}} waiting for a reviewer
- Signals received: {{events.total}}

## Work

{{commitments_table}}

## Checks

{{verify_table}}

Every line above comes from the company's records (commitments, verify results, intake events) for this party and period.
