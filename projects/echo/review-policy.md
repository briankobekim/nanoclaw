# Review tiers by CLASS (edit to taste; Echo confirms the class before applying)

Installed read-only at `/workspace/extra/projects/echo/review-policy.md` (host: `projects/echo/review-policy.md`). Referenced from Echo's instructions.

## COST line (binding; moved here from Echo's instructions, 2026-09-15)

End every formal reply with one line using only numbers you can read from the host's evidence record. Do not estimate tokens; you cannot see them.

`COST: wall_seconds=<record wall_seconds> checks_ran=<checks_ran of frozen_checks> verdict=<record verdict>`

| CLASS value      | Review depth                                             | Second family? |
|------------------|----------------------------------------------------------|----------------|
| docs, chore      | the verifier only; approve if ALL_CHECKS_PASSED          | no             |
| fix, test        | the verifier + diff read against CONTRACT                | no             |
| feature          | the verifier + diff read + pre-mortem comparison         | no             |
| ledger, security, migration, slack-bridge | full review + second-family reviewer; either BLOCK wins | yes |

Rules:
- If CLASS is missing or unrecognized, treat as `ledger`.
- Echo may raise a tier, never lower it.
- The verifier gates on CHECKS only. REPRODUCE is documentation only and is never executed.
- A `VERIFIER_ERROR` verdict is REVIEW BLOCKED at every tier, whatever its `error_reason`
  (`archive_failed`, `spawn_failed`, `removal_unconfirmed`, `docker_uncertain`, `invalid_input`,
  `deadline`): the frozen list was not finished under proven isolation. Do not override it.
- `ALL_CHECKS_PASSED` requires every check to have run, exited 0, not timed out, and had its
  container's removal confirmed by docker. Anything less is never an approval.
- "Second family" means a reviewer running on a different model family than Echo (e.g. via `opencode run --model ...`). Until that is wired up, Echo notes `second_family: not available` in the review and Kobe reviews manually for those classes.

## Revisions (2026-09-15)

A handoff carrying `SUPERSEDES: <prior>` is round two or later. Before applying the class tier:
run `ncl handoffs get --id <prior>` (its `review_notes`) and `ncl handoffs events --id <prior>`,
then list each prior note and whether the revision addresses it. Any unaddressed note is
`CHANGES REQUIRED` again, naming it. The verifier runs on the revision's own id; the prior's
evidence is history, not proof.

## Review dimensions (moved here from Echo's instructions, 2026-09-14)

Cover: correctness, regressions, security, data integrity, maintainability, evidence, tests, product behavior, visual consistency, follow-through.

## Beyond-scope ideas (moved here from Echo's instructions, 2026-09-14)

At most three ideas per review, each tagged `Build now`, `Experiment next`, `Watch`, or `Ignore for now`, each with benefit, cost, and risk. Never pad a routine review.
