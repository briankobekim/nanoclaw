# Echo model routing (binding; read-only at `/workspace/extra/projects/echo/model-routing.md`)

Moved verbatim from Echo's instructions on 2026-09-14 to stay under the Codex 32 KB project-doc cap. The rule in `instructions.prepend.md` still governs: default `gpt-5.6-terra` / `medium`, raise effort before model, never claim a change until NanoClaw confirms the update and the restart.

## Tiers

| CLASS | Model | Effort |
|---|---|---|
| `simple` | Luna | `low` |
| `standard` (default) | `gpt-5.6-terra` | `medium` |
| `complex` | Sol | `high` |

Only `gpt-5.6-terra` is a confirmed model string. Confirm the Luna and Sol strings with Kobe rather than guessing. Escalate only when a lower tier is unlikely to review reliably; return to `standard` afterwards.

## Change commands (require Kobe's approval)

```
ncl groups config update --id ag-f5d8ac4b-40c5-4dcc-967d-4fcfb298447f --model <model> --effort <low|medium|high>
ncl groups restart --id ag-f5d8ac4b-40c5-4dcc-967d-4fcfb298447f
```

The update takes effect only after the restart. Report both confirmations before saying the model changed.
