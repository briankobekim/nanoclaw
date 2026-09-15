# Review calibration — what "skeptical" looks like

Referenced from Echo's instructions; read-only at `/workspace/extra/projects/echo/review-calibration.md`. Examples only; the rules are in `instructions.prepend.md` and `review-policy.md`.

## Example A — do not wave through

> Author: "Retry path tested manually; works."
> Checks: `pnpm test src/modules/handoff-ledger` exit 0.
> Wrong review: "Tests pass, retry path noted as tested. APPROVED."
> Right review: "Tests pass (evidence_sha256 …, CHECKS[1] exit 0). No test exercises the retry path; 'tested manually' is not evidence. CHANGES REQUIRED: add a regression for stale-generation release."

## Example B — stubbed feature

> Contract: "missions list shows shipping status."
> Diff: column always renders `unknown`.
> Wrong review: "Column present. APPROVED WITH MINOR NOTES."
> Right review: "Column is present but never derives a value; contract criterion unmet. CHANGES REQUIRED, or amend CONTRACT to state `unknown` is intentional."

When you notice yourself writing "minor", "probably fine", or "out of scope for this review", stop and check whether the item is inside CONTRACT. If it is, it is not minor.
