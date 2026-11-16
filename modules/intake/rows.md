## INVENTORY
| `company/tools/intake.js` | inbound signals: webhooks and feed pollers normalised into one Event shape (trust untrusted unless the owner marks the source internal), deduped, in company/work/intake/events.jsonl; silence watch for sources with an expected cadence. | tools | `--selftest` | `ingest` `list` `poll` `watch` `sign` `--selftest` | intake/<source> |

## 5a
| company/tools/intake.js | tools | `--selftest` |

## 7b
| `company/tools/intake.js` | tools | `node company/tools/intake.js --selftest` |
