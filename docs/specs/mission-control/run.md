# Mission control CLI — 2026-09-14

Status: clean feature artifact repaired, verified, and independently approved. No commit, push, PR, merge, deploy, or service restart performed in this debug run.

## Ownership and selection

- Owner: retained frontier implementation/debug owner.
- Model: `gpt-5.6-sol`.
- Reasoning effort: `high`.
- Selection reason: the final blockers cross asynchronous callback concurrency,
  durable schema compatibility, Slack parser trust boundaries, and derived
  mission state.

## Outcome contract

- Desired result: one concise `ncl missions list` view backed by a durable,
  automatically enforced source-to-reviewer handoff lifecycle.
- Evidence: focused regressions, migration tests, adjacent and full test suites,
  scoped lint/format, typecheck, build, and an independent artifact review.
- Boundaries: work only in the clean feature worktree; preserve the dirty main
  checkout; no config/personality changes, unrelated source, commit, push, PR,
  merge, deploy, or service restart.
- Authority: local debugging and verification only.

## Data interpretation

- Handoff owner, project, lifecycle, and review outcome come from the durable ledger.
- Task owner and lifecycle come from task sessions and their existing mailboxes.
- Neither source durably stores mission class for this view; class is `unknown`.
- Task records do not durably bind a project; project is `unknown`.
- Review completion does not itself authorize push, deploy, or publication. Incomplete
  review states report shipping `no`; reviewed/closed handoffs and tasks report
  shipping `unknown` until a separate authority source exists.
- Conservative stage mapping is `queued` for pending tasks, `awaiting_delivery`
  for created handoffs, `ready_for_review` only after delivery,
  `review_in_transit` while a review delivery lease is active, and
  `review_complete` after approval/acknowledgement.
- `--group` means tasks owned by that group plus handoffs where that group is
  either source or reviewer.
- The view creates no duplicate mission state and its handler performs reads only,
  through the daemon's existing central and mailbox data surfaces.

## Prior corrective rounds carried into the clean artifact

The mission view previously completed three bounded local repair rounds:

1. Conservative lifecycle labels, per-series-only deduplication, terminal aging,
   orphaned ledger visibility, and involved-group semantics were repaired.
2. A live unknown-command failure was traced to an older in-memory daemon registry.
   A temporary missions-specific local fallback was created under a no-restart
   constraint.
3. That fallback was rejected as workflow-created complexity and removed. The
   normal daemon transport was activated with one authorized local restart and
   the real CLI passed. No fallback code is present in this feature artifact.

Those rounds belonged to the earlier local build. The fresh debug authority below
has its own maximum of three corrective rounds.

## Fresh debug: final publication blockers

### Pre-fix evidence and falsifiable root causes

Four focused regressions failed before production edits while 35 neighboring
tests passed:

- A delivery lease was reclaimed after expiry, then the old release callback
  cleared the replacement reservation.
- A review lease was reclaimed after expiry, then the old completion callback
  finalized the replacement review.
- An otherwise complete formal review recovered `HANDOFF_ID` from a quoted line.
- An otherwise complete formal source package recovered `HANDOFF_ID` from a
  fenced code block.

The first root cause was that a lease persisted only status and timestamp;
complete/release identified the handoff, actor, and fingerprint, but not the
specific attempt. The falsifiable prediction was that adding an atomically
checked, monotonically increasing reservation generation would make every stale
callback fail while allowing the replacement generation to finish.

The second root cause was that ordinary field parsing skipped quote/code lines,
but collapsed-text ID recovery searched the original unfiltered text. The
falsifiable prediction was that recovery over the same parser-eligible lines
would retain the normal Slack-collapsed case and reject quoted/code-only IDs.

A systematic search found only the source-to-reviewer and reviewer-to-source
reserve/complete/release paths, their Slack callbacks, and the manual handoff
transitions. No parallel reservation implementation exists.

### Repair round 1 of 3

The ledger now persists `reservation_kind`, monotonic
`reservation_generation`, and `reservation_expires_at`. Base lifecycle states
remain `created` during delivery and `delivered` during review. Reservation
acquisition conditionally increments the prior generation; complete and release
require the exact kind and generation in the same conditional update. The Slack
callbacks capture and return that generation. Late completion and release from
an expired/reclaimed attempt fail without changing the replacement; replacement
delivery and review attempts still complete normally. Manual deliver/review
transitions also fail while a routed reservation is present.

Collapsed-text recovery now builds its search input only from lines accepted by
the primary parser after fenced-code and blockquote filtering. The existing
otherwise-complete source/review requirements remain unchanged. Normal collapsed
Slack text still recovers its ID; quote, code, incomplete, duplicate, and mixed
content remain non-executable or fail closed.

### Migration compatibility

The original module migration retains its original lifecycle CHECK constraint.
A second portable, transactional module migration adds the three reservation
columns. It also normalizes `delivering` to `created` and `reviewing` to
`delivered` for databases that ran an earlier unpublished experimental schema.
Original v1 databases match no such rows and upgrade normally; fresh databases
run v1 then v2. Migration regressions prove original-v1 upgrade and idempotence,
plus normalization of both experimental in-flight states into retryable base
states. No handoff or event row is deleted.

### Verification evidence

- Pre-fix focused regressions: 4 failed, 35 passed, with failures matching both
  hypotheses.
- Focused post-fix ledger/parser/migration/mission suite: 4 files, 51 tests passed.
- Full `pnpm test` outside the socket-restricted sandbox: 222 files passed,
  2 skipped; 2,623 tests passed, 13 skipped.
- Scoped ESLint: 0 errors and one pre-existing feature warning in the Slack
  identity refresh catch, which intentionally continues to other configured
  identities. Full ESLint reached the unchanged `origin/main` error at
  `src/gateway-providers/onecli-files.ts:103`; this feature has no diff in that
  file.
- Full source Prettier check passed.
- Typecheck passed.
- Build passed.
- `git diff --check` passed.
- Fresh independent high-effort review approved the bounded artifact with no
  remaining MUST-FIX findings. The reviewer independently reran 54 focused
  tests across ledger, migration, enforcement, routing, and missions, plus
  typecheck and diff-check. Live Slack and remote-backend migration execution
  were not repeated. Same-family reviewer coverage is complete; the separate
  other-family review channel remains unavailable/degraded, so this approval
  does not satisfy that distinct workflow gate or authorize publication.

## Rollout and rollback

No rollout occurred in this debug run. On a later authorized rollout, the daemon
migration runner applies the additive fencing migration before accepting work.
Rollback should restore the previous build and restart the same service; the
three additive columns and generation history can remain dormant. Destructive
schema rollback is neither required nor recommended.

## Residual risk

- A callback may complete an expired lease if no replacement has reclaimed it;
  this is intentional because the persisted generation still identifies the
  same attempt. Once reclaimed, old callbacks are fenced.
- Older experimental `delivering`/`reviewing` rows cannot reconstruct whether a
  remote recipient accepted before interruption, so migration conservatively
  normalizes them to retryable base states.
- Slack fallback recovery is deliberately narrow and line-oriented; format
  changes outside the tested collapsed representation fail closed instead of
  advancing the ledger.
- Arbitrary Slack threads with neither a task record nor a handoff record remain
  undiscoverable as missions.
