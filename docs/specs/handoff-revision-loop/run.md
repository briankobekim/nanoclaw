# handoff-revision-loop — run record

## Stage: /team-plan (2026-09-15, primary runtime Claude, model claude-fable-5-1)

Plan artifact: `docs/specs/handoff-revision-loop/plan.md` revision 1. Planning only; no production code or test files written.

### Grounding performed
- Ledger map (schema, transitions, fingerprint, enforcement, verifier refusal ladder, CLI, missions labels) by a read-only Explore agent; key facts cited in plan §3.
- Host primitives map (60 s host sweep and `MODULE-HOOK` pattern, `getDeliveryAdapter().deliver`, owner and DM resolution, absence of stall/idempotency mechanisms, protocol text) by a second read-only Explore agent; cited in plan §3.
- Migration registry semantics read directly: module migrations keyed by `name`, `version` free (`src/db/migrations/index.ts:105-112, 171-176`).
- Live ledger inspected read-only via sqlite3: four open rows (statuses `created` ×2, `delivered`, `changes_required`).
- Grep evidence of absence: `supersedes|parent_handoff|revision|previous_handoff|related_handoff` and `escalat|stale|reminder|nudge|needs_you|waiting_on|stalled` over `src/` return no handoff-related hits.

### Design decisions recorded
- Revision is a new handoff with a validated `supersedes` link, not a backward transition (plan §2 non-goals for the reasons).
- Link is not part of the fingerprint; validated and stored by the ledger, bound to the Slack line by enforcement (plan §4.1).
- Stall dedupe uses an `owner_pinged` ledger event rather than a new table or in-memory state (plan §4.2).
- Thresholds 1 h (`review_blocked`) / 6 h (other open) and once-per-stall are defaults for Brian to confirm or override.

### Cross-model review (plan stage)
- Reviewer: Codex CLI 0.151.0 at `/Users/kobekim/.nvm/versions/node/v24.19.0/bin/codex`; requested model `gpt-5.6-sol`, `model_reasoning_effort="high"`, `--ignore-user-config --ephemeral --yolo`, schema `codex-review-output.schema.json`, vendored prompt `codex-adversarial-prompt.md` with four placeholders filled.
- Command (foreground, Bash timeout 3600000 ms), cwd = repo root:
  `codex exec --ignore-user-config --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --ephemeral --yolo --output-schema <schema> --output-last-message <out.json> < <composed-prompt>`
- Result: `completed` — exit 0, 266 s wall, 90,469 tokens; JSON validated against the schema (verdict `needs-attention`, 5 findings, all required fields present). Effective model/effort not echoed in process metadata; recorded as requested by explicit CLI arguments. Raw verdict kept at scratchpad `plan-review/verdict.json`.
- Recorded as: `must_fix`. Coverage: other-family (Codex) review completed; not degraded.

#### Findings, verified by the lead against plan revision 1 and source

| # | Codex finding (severity, confidence) | Lead verification | Disposition |
|---|---|---|---|
| 1 | `supersedes` outside the fingerprint; prior fingerprint not re-verified at creation; no DB-level immutability (high, 0.97) | Confirmed. The ledger's existing integrity model treats row corruption as in scope (`fingerprintOfRow` self-check in `ledger.ts:284-286`, verifier `index.ts:547-549`); leaving the link out was inconsistent with that model. The trigger recommendation is rejected: the ledger detects and refuses tampering rather than preventing it, and a trigger would be the only prevention mechanism in the module. | **MUST-FIX, accepted** (fingerprint binds the link via conditional ninth canonical key; prior fingerprint checked at revision; A7 rewritten, A9 added). Trigger part rejected. |
| 2 | Event-after-send cannot guarantee exactly-once; multi-owner partial success unrepresentable (high, 0.99) | Confirmed: §1 promised "one message per stall" while §4.2 delivered at-least-once; one handoff-level event could not express partial recipient success. Outbox recommendation rejected as heavier than the failure it prevents and because a claim-before-send would record undelivered pings (silent miss), the worse failure. | **MUST-FIX, accepted** as a contract correction: §1 now states at-least-once; dedupe is per (handoff, recipient); E9, E10 added. |
| 3 | Scan-then-send race can ping a state that stopped being stalled (medium, 0.92) | Confirmed as possible; window is the owner resolution plus one network call. Conditional-claim transaction rejected for the same reason as #2. | **SHOULD-FIX, accepted** cheaply: re-read and re-check immediately before each send (§4.2 step 6); E8 added; residual window recorded in §9. |
| 4 | No populated v1→v2 migration test (medium, 0.91) | Confirmed: `ledger.test.ts` fixture runs all migrations on a fresh DB; the live rollout applies `ALTER TABLE` to a populated ledger with no test. | **MUST-FIX, accepted**: A10 in new `migration.test.ts`. |
| 5 | Mission view labels only the prior side; successor shows as unrelated (medium, 0.96) | Confirmed against §2 scope ("labels for revised and superseded") and `missions.ts:107-120` (no link field). | **MUST-FIX, accepted**: `revises` mission field; D3 added. |

One bounded correction batch applied → plan revision 2. No second review loop (per contract). Remaining risks are listed in plan §9 and are decisions for Brian, not open findings.

### Approval
Brian approved plan revision 2 as written on 2026-09-15 ("approved"), thresholds unchanged (1 h blocked / 6 h open).

## Stage: /team-build (2026-09-15, primary runtime Claude, model claude-fable-5-1)

Plan: `docs/specs/handoff-revision-loop/plan.md` revision 2. Branch `production` at 991fb610; working tree clean apart from this spec directory and the four deliberately untracked personal paths (QuiverIQ launchd files, `projects/architects-golf-club/`). No user edits at risk.

Ownership: lead implements ledger, migration, enforcement, CLI, missions, docs, personas. One worker implements `stall-ping.ts`, `stall-ping.test.ts`, the `host-sweep.ts` hook block, and the `index.ts` import against the `recordOwnerPing` interface fixed in the plan (independent write set; interface specified in plan §4.2).

Build log (appended as work proceeds):

- 19:44 — Tests materialized first: A1–A9 appended to `ledger.test.ts`, A10 in new `migration.test.ts`, B1–B2 in `slack-enforcement.test.ts`, C1 in `handoffs.test.ts`. Ran once before implementing: 13 failed for the expected reasons (`no such column: supersedes`, `recordOwnerPing is not a function`, promises resolving instead of rejecting, `handoffSupersedesMigration` undefined). D1–D3 appended to `missions.test.ts` after reading the task fixture; E1–E10 delegated to the worker with the same test-first instruction.
- 19:48 — Implemented `migration.ts` v2 (`module:nanoclaw.handoff-ledger:supersedes`), `ledger.ts` (`HandoffRow.supersedes`, conditional ninth canonical key, `createHandoff` revision validation inside the transaction, `superseded` event, `recordOwnerPing`, event/actor constants), `slack-enforcement.ts` (SUPERSEDES bound like PROJECT), `handoffs.ts` (`--supersedes`), `missions.ts` + `format-missions.ts` (`revises` field and column, `superseded` stage, next-action copy). Result: `vitest run` ledger/enforcement/migration/handoffs → 4 files, 38 tests passed; missions/handoffs → 2 files, 14 passed.
- 19:50 — Docs: `projects/shared-protocol.md` (field list, revision rule, Echo's prior-round duty), `projects/echo/review-policy.md` (Revisions section), Atlas and Echo personas (backups in `groups/.backups/revision-loop-20260915/`, SHA256SUMS recorded). Echo composed AGENTS.md dry-run: 30,793 B of 32,768, nothing dropped (persona 3,888 B, max 4,375).
- 19:51 — `deliver-with-inputs.test.ts` fixture needed `supersedes: null` (typecheck TS2741); added. Prettier rewrote `missions.ts`/`missions.test.ts`. `vitest run` over ledger module (minus worker-owned stall-ping), verifier unit files (`run-checks`, `timeout-cleanup`, `persistence`), and CLI: 9 files, 136 tests passed. Typecheck clean apart from the worker's in-progress `stall-ping.test.ts`. ESLint: 0 errors, 1 pre-existing `no-catch-all` warning in `notifyLiveRejection` (not introduced by this build).
- Diff inspected for all lead-owned source files (ledger, migration, enforcement, handoffs, missions, format-missions) and for the protocol/persona text against the backups; matches plan §4.1 exactly. Edge cases exercised by tests: unknown prior, self-reference, tampered prior, wrong pair/project, every non-revisable status, second successor (code path and index), link cleared or re-pointed after insert, populated v1→v2 upgrade with FK and unique-index enforcement and idempotent re-run.
- 19:52 — Migration dry-run against a `.backup` copy of the live `data/v2.db` (8 handoffs, 29 events): exactly one migration pending and applied (`module:nanoclaw.handoff-ledger:supersedes`); row and event counts unchanged; `supersedes` column (nullable) and `idx_handoffs_supersedes` present; all eight live rows read back with `supersedes = NULL`. Live database confirmed untouched (no `supersedes` column). Copy kept at scratchpad `migration-dryrun/v2-copy.db`.
- 19:54 — Worker delivered `stall-ping.ts` (161 lines), `stall-ping.test.ts` (E1–E10, written first and observed failing on the missing module), the `MODULE-HOOK:handoff-stall-ping` block in `host-sweep.ts` (lines 159–166), and the barrel import. Lead read the module in full: matches plan §4.2 steps 1–8 (open unsuperseded rows → thresholds → per-recipient dedupe on `owner_pinged` payload → re-read before send → deliver → record; warn-and-continue on send failure, error-and-continue on record failure). Worker deviations, accepted: `recordOwnerPing` injected through `deps` (needed for E9, allowed by the brief); `deps` typed with `Pick<>` so minimal fakes typecheck; the "nothing stalled" early return precedes owner/adapter lookup (no observable difference; E6 still warns once and records nothing); `stallMessage` exported.
- Fresh checks (all run by the lead after integration):
  - `pnpm typecheck` → clean.
  - `vitest run src/modules/handoff-ledger src/cli/resources/handoffs.test.ts src/cli/resources/missions.test.ts src/modules/verifier/{run-checks,timeout-cleanup,persistence}.test.ts src/host-core.test.ts` → 11 files, 187 tests passed (includes A1–A10, B1–B2, C1, D1–D3, E1–E10).
  - `vitest run` (full unit suite) → 188 files passed, 1 failed, 1 skipped; 2,424 tests passed, 4 failed, 19 skipped. The 4 failures are all `scripts/update/transaction.e2e.test.ts` (path-safety validator vs. the apostrophe in this checkout's path), identical to the pre-build baseline recorded earlier today; unrelated to this change.
  - `prettier --check` on every changed `.ts` file → conforms. ESLint → 0 errors; only the repo-wide `no-catch-all` warning class (two new instances in `stall-ping.ts` on the plan-mandated log-and-continue catches, one in the new hook block mirroring the approvals block).
  - `grep MODULE-HOOK:handoff-stall-ping src/host-sweep.ts` → lines 159 and 166.
- Plan fidelity: every §5 case exists under its planned name and asserts what the plan says; no scope added beyond §2. Verifier untouched (`git status` shows nothing under `src/modules/verifier/`).
- Gate: build coherent, focused checks pass, diff inspected, deviations explicit → ready for `/team-review --implementation`.
