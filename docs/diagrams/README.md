# Diagrams

Architecture and sequence diagrams live inline as Mermaid in the documents that
use them, so they render on GitHub and stay next to the prose they explain.
Keeping them here as exported images would mean a second copy that goes stale.

Screenshots are the exception, because they cannot be expressed as Mermaid.
They are captured by `pnpm screenshots`, which drives a real browser against the
stack `make demo` starts — it also generates a burst of traffic first, because a
screenshot of an empty dashboard is worse than no screenshot.

Present:

| File | Shows |
|---|---|
| `console-overview.png` | Overview, 24h range, charts populated |
| `console-live.png` | Live requests with a row expanded |
| `console-audit.png` | Audit log after chain verification passes |
| `console-rate-limits.png` | Limit configuration and live Redis bucket state |
| `console-policies.png` | Rule list with an evaluation result and trace |
| `console-settings.png` | Tenant, people and their mirrored database roles |
| `console-signin.png` | The identity provider's sign-in page |
| `trace-example.png` | One tool call in Jaeger |

Missing, and why:

| File | Blocked on |
|---|---|
| `grafana-slos.png` | Application metrics were binding to a no-op meter; fixed in source, but the images need rebuilding and the dashboards re-verifying before these are worth capturing. |
| `grafana-mirroring.png` | Same. |

The capture script uses a 1600×1000 viewport and the dark theme, which is the
default everywhere.
