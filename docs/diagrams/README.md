# Diagrams

Architecture and sequence diagrams live inline as Mermaid in the documents that
use them, so they render on GitHub and stay next to the prose they explain.
Keeping them here as exported images would mean a second copy that goes stale.

Screenshots are the exception, because they cannot be expressed as Mermaid.
Capture these after `make demo`:

| File | What to capture |
|---|---|
| `console-overview.png` | Overview page, 24h range, charts populated |
| `console-live.png` | Live requests with a row expanded, showing the token exchange detail |
| `console-audit.png` | Audit log after clicking **Verify chain**, green banner visible |
| `console-policies.png` | Policies page with an evaluation result and its rule trace |
| `trace-example.png` | One trace in Jaeger, spans expanded across all four services |
| `grafana-slos.png` | The Gateway SLOs dashboard |
| `grafana-mirroring.png` | The Permission mirroring dashboard |

Use a viewport around 1600×1000 and the dark theme, which is the default
everywhere. Reference them from the README once they exist.
