# Mission control CLI — 2026-09-14

Status: local implementation repair round 3, verification, and one authorized local service restart complete; no publication authorized.

## Ownership and selection

- Owner: retained frontier implementation owner.
- Model: `gpt-5.6-sol`.
- Reasoning effort: `high`.
- Selection reason: the view crosses central handoff state, per-session task state,
  caller scoping, and safety-sensitive ship-gate interpretation in a heavily dirty checkout.

## Outcome contract

- Desired result: one concise `ncl missions list` view for active and recent work.
- Evidence: focused CLI tests, lint, typecheck, and build for the implemented surface.
- Boundaries: derive from existing task mailboxes and the handoff ledger; no new
  service, database, migration, model/config/personality change, commit, push,
  PR, merge, deploy, or unrelated cleanup. One exact local service restart was
  authorized in corrective round 3 to load the verified build.
- Authority: local implementation and verification only.
- Follow-up owner: Brian decides whether and when to repair the separately known
  Slack formatted-text handoff boundary and publish any local changes.

## Data interpretation

- Handoff owner, project, lifecycle, and review outcome come from the durable ledger.
- Task owner and lifecycle come from task sessions and their existing mailboxes.
- Neither source durably stores mission class for this view; class is `unknown`.
- Task records do not durably bind a project; project is `unknown`.
- Review completion does not itself authorize push, deploy, or publication. Incomplete
  review states report shipping `no`; reviewed/closed handoffs and tasks report
  shipping `unknown` until a separate authority source exists.
- Conservative stage mapping is `queued` for pending tasks, `awaiting_delivery`
  for created handoffs, `ready_for_review` only after delivery, and
  `review_complete` after approval/acknowledgement. The view does not claim
  `working` or `ready_to_ship` from records that do not prove those states.
- `--group` means tasks owned by that group plus handoffs where that group is
  either source or reviewer.
- The view creates no duplicate mission state and its handler performs reads only,
  through the daemon's existing central and mailbox data surfaces.
- The resource depends on the existing untracked `src/modules/handoff-ledger/`
  implementation and `src/cli/resources/handoffs.ts`. Their pre-existing barrel
  registration and group-scope entry were inspected and preserved; this change
  adds only the adjacent `missions` registration.

## Verification evidence

- `pnpm exec vitest run src/cli/stdin-json.e2e.test.ts src/cli/resources/missions.test.ts src/cli/resources/tasks.test.ts src/cli/resources/handoffs.test.ts`: 4 files, 42 tests passed.
- `pnpm exec eslint src/cli/registry.ts src/cli/resources/index.ts src/cli/format-missions.ts src/cli/resources/missions.ts src/cli/resources/missions.test.ts src/cli/client.ts`: 0 errors and 1 pre-existing warning at `src/cli/client.ts:66` from the existing top-level catch (`no-catch-all`).
- `pnpm exec prettier --check src/cli/registry.ts src/cli/resources/index.ts src/cli/format-missions.ts src/cli/resources/missions.ts src/cli/resources/missions.test.ts src/cli/client.ts`: passed.
- `pnpm run typecheck`: passed.
- `pnpm run build`: passed.
- The existing socket E2E invokes the real CLI client through `startCliServer`,
  preserving a permanent check for the single client-to-daemon transport.
- After the one authorized restart, `./bin/ncl missions list --limit 12` exited 0
  through the daemon and returned 7 local mission rows. `./bin/ncl help` exited 0
  and listed `missions` with verb `list`.
- Focused coverage proves combined task/handoff output, conservative unknowns,
  queued, awaiting-delivery, ready-for-review, changes-requested, blocked,
  review-complete, and completed derivation, agent visibility boundaries,
  server-rendered human output, per-series-only correlation, legacy shared
  session safety, terminal aging, and orphaned-ledger visibility.

## Repair round 1

All review findings were confirmed; none were rejected. The pre-fix focused
regression run failed 5 of 8 tests for the predicted reasons:

- lifecycle labels promoted created/approved records beyond their evidence;
- pending task rows were labeled working despite not being processing records;
- recent filtering treated only completed/cancelled stages as terminal;
- dedupe keyed every task row by session ID, including a legacy shared session;
- the host's nominally unfiltered path filtered ledger rows through current groups.

The repair separates lifecycle display from ship authority, carries terminal and
per-series facts alongside derived task rows, applies dedupe only to isolated
`system:tasks:<series>` sessions, filters host handoffs only when `--group` was
actually supplied, and keeps ID fallback for missing groups. The fresh focused
run passed 8 of 8 mission regressions; the adjacent final run passed 40 of 40.
Corrective rounds used: 1 of 3.

## Repair round 2

The live acceptance failure was reproduced exactly: `./bin/ncl missions list
--limit 12` exited 1 with unknown command `missions-list`, even though source,
unit tests, typecheck, and build all passed. The registration chain and built
artifacts were present, but the active daemon had started at 13:47 while the
updated `dist` was built at 14:26. Because `bin/ncl` is a socket client, it was
dispatching against the daemon's older in-memory registry.

A no-restart workflow constraint led to a temporary `missions-list`-specific
client fallback and fallback-specific subprocess test. It made the command work,
but introduced a second database read/dispatch path instead of activating the
already-correct daemon build. Corrective round 3 rejected and removed that
workflow-created complexity in full. Corrective rounds used: 2 of 3.

## Repair round 3

The coordinator corrected the earlier restart constraint and authorized one
reversible restart of the exact local service. The mission-specific local-read
module, its client branch/import, and its fallback-specific E2E test were deleted.
`src/cli/client.ts` is byte-for-byte back to its pre-mission state and all commands
again use the daemon socket as their sole transport and dispatch source. Stale
generated `dist/cli/local-read*` and fallback-test artifacts were also removed;
a fresh build did not recreate them.

After the 42-test adjacent suite, formatter, lint, typecheck, and build passed,
`launchctl kickstart -k gui/501/com.nanoclaw-v2-eacf8390` was executed exactly once.
Launchd reported the service running as PID 54291. Startup logs showed Slack bot
users `U0BSP5T2JP2` and `U0BRT6E3E0N` each authenticate and reach socket-mode
connected, followed by adapter instances `slack` and `slack-quiverchat` starting,
the CLI socket listening, and NanoClaw running. Both live CLI acceptance commands
then passed through the daemon. Corrective rounds used: 3 of 3.

## Rollout and rollback

The verified build was activated only by the one authorized local NanoClaw service
restart; there was no deployment or publication. The additive CLI resource can be
rolled back by removing its resource/formatter/tests, its resource-barrel import,
and its group-scope whitelist entry, then rebuilding and restarting the same local
service. Existing task and handoff records are untouched.

## Known limits

- Arbitrary Slack threads with neither a task record nor a handoff record are not
  discoverable as missions from the current durable data.
- Closed history from the legacy shared task session cannot be enumerated through the
  mailbox interface; current per-series task sessions do retain discoverable history.
- Multiple distinct handoffs from one source session remain distinct review items.
- The known Slack formatted-text handoff delivery defect is deliberately unchanged.
