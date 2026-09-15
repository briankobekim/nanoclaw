# Handoff revision loop and owner "needs you" ping

Status: PROPOSED (plan revision 2, 2026-09-15, after one cross-model correction batch; see `run.md`). Approval state: **not approved**. `/team-build` may not start until Brian approves this exact revision.

Executable acceptance criteria apply (behavior-changing work); the cases in §5 are materialized into the test tree by `/team-build` before any implementation.

## 1. Outcome

When Echo answers a handoff with `CHANGES REQUIRED` or `REVIEW BLOCKED`, Atlas can post a **linked revision** that goes back to Echo as the next round, instead of opening an unrelated new handoff. The ledger records the link in both directions, Echo can read the previous round's notes, and the mission view shows one thread of work rather than orphaned records.

Separately, when any open handoff sits untouched for too long, the host sends Brian a Slack message per stall saying which handoff, what state it is in, who it is waiting on, and how to look at it. Delivery is **at least once**: normally exactly one message per stall and recipient; a duplicate is possible only if the host crashes or Slack times out between a successful send and the ledger record of it. A missed ping is never the accepted failure mode. Nothing stalls silently.

Users: Brian (owner), Atlas (source agent, `ag-1787323600795-bvj1pt`), Echo (reviewer agent, `ag-f5d8ac4b-40c5-4dcc-967d-4fcfb298447f`).

## 2. Scope and non-goals

In scope:
- A `supersedes` link on handoffs, validated by the ledger at creation, bound to the Slack message by enforcement, exposed through `ncl handoffs create --supersedes`.
- `superseded` ledger event on the prior handoff.
- Mission view labels for revised and superseded handoffs.
- A host sweep that pings the owner's Slack DM about stalled handoffs, deduplicated by a ledger event.
- Protocol and persona text so Atlas and Echo use the loop.

Non-goals (explicitly rejected):
- Moving a handoff backward (`changes_required → delivered`) on the same row. It collides with the verifier's one-inputs-row-per-handoff primary key (`src/modules/verifier/migration.ts:24`), would overwrite `review_outcome`/`review_notes`, and would break the protocol rule that `run_checks` verifies an ID exactly once.
- Per-round history columns. `handoff_events` already holds the trail.
- Repeated reminders for the same stall, digests, dashboards, or configurable thresholds.
- Any change to the verifier, the fingerprint algorithm, egress, or memory.

## 3. Current architecture (evidence)

- Status set and terminality: `HandoffStatus` `src/modules/handoff-ledger/ledger.ts:10-17`; `changes_required`, `review_blocked`, `closed` have no outgoing transition. `transition()` `ledger.ts:383-417` is source-only and single-`from`.
- Creation: `createHandoff` `ledger.ts:169-212` validates `ID_PATTERN`, five required text fields, source ≠ reviewer; appends `created` event `{fingerprint, project, goal}`.
- Fingerprint: `canonical()` `ledger.ts:89-109` over `id, source_agent_group_id, reviewer_agent_group_id, project, goal, outcome, scope, authority`; re-validated in every transition, in Slack enforcement (`slack-enforcement.ts:203-207`), and by the verifier (`src/modules/verifier/index.ts:547-549, 1004-1049`).
- Events: `appendEvent` `ledger.ts:115-141` (module-private), `sequence = MAX+1`, `UNIQUE(handoff_id, sequence)`; non-agent actor `host:verifier` already used (`src/modules/verifier/record.ts:335`).
- Slack enforcement: source→reviewer requires `row.status === 'created'` and all `CONTRACT_FIELDS` (`slack-enforcement.ts:25-41, 210-242`); reviewer→source requires `delivered` (`:244-261`); any parsed `NAME: value` line is available via `fields.get()` (`FIELD_LINE` `:45`, `parseTrackedHandoffMessage` `:117-149`); rejections notify the sender (`notifyLiveRejection` `:321-338`).
- Migrations: module migrations are keyed by `name` (`src/db/migrations/index.ts:105-112, 171-176`); ledger v1 `module:nanoclaw.handoff-ledger:initial` (`migration.ts:3-50`); verifier imports it first for FK order (`verifier/migration.ts:14`).
- CLI: `src/cli/resources/handoffs.ts:124-154` `create` (args `--id --source(host) --reviewer --project --goal --outcome --scope --authority`); all ops `access: 'open'`.
- Missions: `handoffStage` `src/cli/resources/missions.ts:65-81`, `handoffNextAction` `:83-100`, terminal set `:232` = `changes_required, review_blocked, closed`.
- Host timer: `src/host-sweep.ts:42` 60 s tick; central-DB module hook pattern `MODULE-HOOK:approvals-reason-sweep` `:148-155` calling `sweepAwaitingReasonRejects()` (`src/modules/approvals/reason-capture.ts:163-175`).
- Host→Slack without an agent turn: `getDeliveryAdapter().deliver(channelType, platformId, threadId, kind, content, files?, instance?)` (`src/delivery.ts:93`, `src/channels/channel-registry.ts:96-108`); plain-text precedent `src/modules/permissions/index.ts:654-670`. Owner resolution: `getOwners()` (`src/modules/permissions/db/user-roles.ts:69`) → `ensureUserDm(userId)` (`src/modules/permissions/user-dm.ts:54`) → messaging group with `channel_type`, `platform_id`, `instance`. Live: owner `slack:U0BRW7PA4N5`, DM group `mg-1787323600796-jsr0h9` (`slack:D0BRWNQCTED`, instance `slack`).
- No existing link, stall, reminder, or host-level idempotency mechanism for handoffs (grep evidence in `run.md`).
- Protocol text that makes today's behavior terminal: `projects/shared-protocol.md:249-255`; Atlas persona `groups/dm-with-kobe/instructions.prepend.md:258-262`; Echo persona `groups/quiverchat/instructions.prepend.md:27`.

Live ledger at planning time: `handoff-1789503177574-b2315abc` `changes_required` since 2026-09-15T22:48Z; `handoff-1789407737214-fe7ae416` `delivered` since 2026-09-14; `RECOVERY-20260909-ATLAS-ECHO` and `handoff-1789406994832-675d2d37` `created` since 2026-09-09 / 2026-09-14.

## 4. Design

### 4.1 Revision = new handoff with a validated back-link

**Schema** (new module migration in `src/modules/handoff-ledger/migration.ts`, `version: 2`, `name: 'module:nanoclaw.handoff-ledger:supersedes'`, registered after v1):

```sql
ALTER TABLE handoffs ADD COLUMN supersedes TEXT NULL REFERENCES handoffs(id);
CREATE UNIQUE INDEX idx_handoffs_supersedes ON handoffs(supersedes) WHERE supersedes IS NOT NULL;
```

The partial unique index is the database-level guarantee that a handoff has at most one successor. `HandoffRow` gains `supersedes: string | null`.

**Ledger** (`createHandoff` input gains `supersedes?: string`). In one transaction, when `supersedes` is set:
1. `supersedes` must match `ID_PATTERN` and differ from `id`.
2. Prior row must exist, else `handoff <prior> not found`.
3. Prior row must pass its own integrity check: `fingerprintOfRow(prior) === prior.fingerprint`, else `handoff <prior> ledger fingerprint does not match its own fields` (same wording as `deliverHandoffWithInputs`). A corrupted prior cannot be revised.
4. Prior `source_agent_group_id`, `reviewer_agent_group_id`, and `project` must equal the new input's, else `revision must match the source, reviewer, and project of <prior>`.
5. Prior `status` must be `changes_required` or `review_blocked`, else `handoff <prior> is <status>; only a changes_required or review_blocked handoff can be revised`.
6. No row may already have `supersedes = prior`, else `handoff <prior> is already superseded by <successor>`. The index backs this.
7. Insert the new row (`status: 'created'`, `supersedes: prior`, fingerprint computed as below); append `created` on the new row with payload `{fingerprint, project, goal, supersedes}`; append `superseded` on the prior row, actor = source, payload `{fingerprint: prior.fingerprint, successor: id}`. Prior `status` and `updated_at` are not touched.

**Fingerprint binds the link.** `canonical()` gains a ninth key, `supersedes`, that is emitted **only when set**. Rows without a link keep today's byte-identical canonical form, so every existing fingerprint, every stored `inputs_fingerprint`, and the verifier's re-validation stay valid without a data migration. Rows with a link hash it, so relinking or clearing `supersedes` after insert makes `fingerprintOfRow(row) !== row.fingerprint`, and the existing checks (enforcement `slack-enforcement.ts:203-207`, `deliverHandoffWithInputs`, verifier preflight and per-check revalidation) refuse the row. `fingerprintOfRow` and the `canonical` input type gain `supersedes?: string | null`. This is the same integrity model the ledger already uses for contract fields: tampering is detected and refused, not prevented by a trigger. (Correction from cross-model review; supersedes plan revision 1, which left the link outside the fingerprint.)

Invariants: a handoff has at most one successor; a successor's prior is `changes_required` or `review_blocked` at link time and never changes afterward; the link is covered by the successor's fingerprint from insert onward; `superseded` never alters the prior's status; every state-changing path still goes through the existing `expectActor`/`expectStatus` guards.

**Slack enforcement** (`slack-enforcement.ts`): one optional contract line `SUPERSEDES: <prior id>`. In the source→reviewer branch, after the existing FINGERPRINT/PROJECT/GOAL checks: if `row.supersedes` is set, the message must contain `SUPERSEDES` equal to it; if `row.supersedes` is null, the message must not contain `SUPERSEDES`. Either failure rejects with `SUPERSEDES does not match the trusted ledger` (same `mismatch` helper, same sender notification). No change to `CONTRACT_FIELDS`, `TRACKED_MARKERS`, the parser, or the reviewer→source branch.

**CLI** (`src/cli/resources/handoffs.ts`): `create` gains optional `--supersedes <id>` passed through to `createHandoff`. `get`/`list` already return the full row, so `supersedes` appears without change. Access stays `open` (the ledger's source check is the authority boundary, as today).

**Missions** (`missions.ts`): compute the set of superseded ids from the rows already loaded. A superseded row gets stage `superseded`, next action `none`, and counts as terminal. A successor row carries its link in a new declared mission field `revises` (the prior id; empty for first rounds and task rows), so both sides of a revision are visible as one thread from `ncl missions list`. `changes_required` next action becomes `source revises with ncl handoffs create --supersedes <id>`; `review_blocked` becomes `resolve the blocker, then revise with --supersedes <id>`.

**Verifier**: unchanged. A revision is a new id with its own `verification_inputs` row and its own run.

**Protocol and personas** (documentation, same commit; personas are gitignored local config, backed up under `groups/.backups/revision-loop-<date>/` before edit):
- `projects/shared-protocol.md:118-135` field list gains `SUPERSEDES: prior HANDOFF_ID when this is a revision; omit on a first round` after `FINGERPRINT`. `:249-255` is rewritten: a `changes_required` or `review_blocked` outcome is answered by a revision created with `--supersedes`, carrying a freshly captured `CHECKPOINT`, `CHECKS`, and evidence; the prior stays in its state and gains a `superseded` event; `run_checks` still verifies each id exactly once.
- Atlas persona `:258-262`: same rule in Atlas's words.
- Echo persona `:27` and `projects/echo/review-policy.md`: on a revision, first run `ncl handoffs get --id <prior>` and `ncl handoffs events --id <prior>` and confirm each prior note is addressed before applying the class tier; unresolved notes are `CHANGES REQUIRED` again.

### 4.2 Owner "needs you" ping

New file `src/modules/handoff-ledger/stall-ping.ts`, side-effect imported from `handoff-ledger/index.ts`, and one central-DB hook block in `src/host-sweep.ts` next to the approvals hook:

```ts
// MODULE-HOOK:handoff-stall-ping:start
const { sweepStalledHandoffs } = await import('./modules/handoff-ledger/stall-ping.js');
await sweepStalledHandoffs();
// MODULE-HOOK:handoff-stall-ping:end
```

`sweepStalledHandoffs(now = Date.now())`:
1. Load all rows with `status <> 'closed'` (`listAllHandoffs`), drop any row that has a successor.
2. A row is stalled when `now - Date.parse(updated_at)` exceeds the threshold: `review_blocked` → **1 hour**; every other open status → **6 hours**. Constants in the module (`STALL_MS_BLOCKED`, `STALL_MS_OPEN`).
3. Resolve recipients: `getOwners()` → `ensureUserDm(ownerId)` per owner → skip owners without a DM. If no adapter (`getDeliveryAdapter()` null) or no recipient, log one warning and return without recording anything (retried next tick).
4. Dedupe is **per handoff and per recipient**: a (row, recipient) pair is already pinged when an `owner_pinged` event on that handoff has payload `status === row.status && updated_at === row.updated_at && recipient === mg.platform_id`. Read via `listHandoffEvents`. Partial success across several owners is therefore representable: each recipient that was sent to is recorded; the others are retried next tick.
5. If nothing is newly stalled, return.
6. **Immediately before each send, re-read the row** (`getHandoff`) and re-check that it still has the same `status` and `updated_at` and still has no successor; otherwise skip it silently (it stopped being stalled between the scan and the send). This narrows the stale-state window to the network call itself; a ping that races the final few hundred milliseconds carries the `updated_at` it describes and points at `ncl handoffs get`, so Brian always sees the current state when he looks.
7. Send **one message per stalled handoff** to each owner DM via `adapter.deliver(mg.channel_type, mg.platform_id, null, 'chat-sdk', JSON.stringify({ text }), undefined, mg.instance)`. Text:

```
⏳ Handoff needs attention
<id> (<project>) has been `<status>` for <N> hours.
Waiting on: <who>. Next: <action>.
ncl handoffs get --id <id>
```
`who`/`action` map: `created` → Atlas / deliver the formal handoff; `delivered` → Echo / record a review outcome; `changes_required` → Atlas / revise with `--supersedes`; `review_blocked` → you / resolve the blocker, then Atlas revises; `approved` → Atlas / acknowledge; `acknowledged` → Atlas / close with evidence.
8. After each successful `deliver` for a (handoff, recipient) pair, append one `owner_pinged` event (actor `host:ping`, payload `{status, updated_at, pinged_at, recipient, platform_message_id}`) through a new exported `recordOwnerPing()` wrapper in `ledger.ts`. If `deliver` throws or times out before returning: log a warning with the handoff id and recipient, append nothing, continue with the next pair; the sweep retries next tick. If the event append throws after a successful send, or the host dies between the two: log an error where possible; the next tick sends one duplicate to that recipient. This is the at-least-once contract from §1, chosen deliberately over a durable claim-before-send outbox: a claim written before the send would record pings that were never delivered, which is the failure mode we care about most (silent miss), and an outbox table is more machinery than one host sweep on a four-row ledger justifies. Recorded as a decision from cross-model review.

Failure boundaries: the hook is wrapped in the sweep's existing try/catch-and-log so a ledger or Slack failure never stops session maintenance. Concurrent agent writes can race the `MAX+1` sequence (`UNIQUE(handoff_id, sequence)`) → the append throws → logged → one duplicate next tick. No in-memory state; restart-safe because dedupe lives in `handoff_events`.

Observability: every ping is visible in `ncl handoffs events --id <id>`; every skip-for-failure is a host log line with the handoff id.

Expected first-run effect on the live ledger: on the first tick after restart Brian receives pings for `RECOVERY-20260909-ATLAS-ECHO`, `handoff-1789406994832-675d2d37` (both `created` > 6 h), `handoff-1789407737214-fe7ae416` (`delivered` > 6 h), and `handoff-1789503177574-b2315abc` once it has been `changes_required` for 6 h and is not yet revised. This is the live acceptance check.

## 5. Acceptance criteria as test cases

Existing framework: vitest; ledger tests use the in-memory portable DB fixture already in `ledger.test.ts`; enforcement tests use the `deps()`/`context()` helpers in `slack-enforcement.test.ts`.

`src/modules/handoff-ledger/ledger.test.ts`
- **A1** `createHandoff with supersedes links a new round to a changes_required handoff` — asserts new row `supersedes === prior.id`, new row `status === 'created'`, prior `status` still `changes_required` and `updated_at` unchanged, prior's last event `event_type === 'superseded'` with `payload.successor === new id`, new row's `created` event `payload.supersedes === prior.id`.
- **A2** `createHandoff with supersedes accepts a review_blocked prior` — same link assertions with a `review_blocked` prior.
- **A3** `createHandoff with supersedes rejects a prior that is not changes_required or review_blocked` — for priors in `created`, `delivered`, `approved`, `acknowledged`, `closed`: throws `/only a changes_required or review_blocked handoff can be revised/` and `getHandoff(newId)` is undefined.
- **A4** `createHandoff with supersedes rejects a mismatched source, reviewer, or project` — three cases each throw `/revision must match the source, reviewer, and project/`; no row inserted.
- **A5** `createHandoff with supersedes rejects an unknown or self-referencing prior` — unknown id throws `/not found/`; `supersedes === id` throws.
- **A6** `a handoff can be superseded only once` — second `createHandoff` with the same `supersedes` throws `/already superseded by/`; exactly one row has that `supersedes`; a direct SQL insert of a second successor fails on `idx_handoffs_supersedes`.
- **A7** `the fingerprint of a revision covers the supersedes link` — `fingerprintOfRow(revision) === revision.fingerprint`; after a direct SQL `UPDATE handoffs SET supersedes = <other existing id>` and after `SET supersedes = NULL`, `fingerprintOfRow(row) !== row.fingerprint`; a first-round row's fingerprint is byte-identical to the value computed by the pre-change canonical form (fixture constant), proving existing fingerprints are unchanged.
- **A8** `recordOwnerPing appends an owner_pinged event without changing the handoff` — event actor `host:ping`, payload as specified including `recipient`, row `status`/`updated_at` unchanged.
- **A9** `createHandoff with supersedes rejects a prior whose stored fingerprint does not match its fields` — corrupt the prior's `goal` by direct SQL, attempt a revision: throws `/ledger fingerprint does not match its own fields/`; no successor row, no `superseded` event.
- **A10** `the supersedes migration upgrades a populated v1 ledger without loss` (`src/modules/handoff-ledger/migration.test.ts`, new) — apply only v1, insert two handoffs and four events by SQL, apply v2: both rows and all events read back unchanged with `supersedes IS NULL`; `idx_handoffs_supersedes` exists; inserting a row whose `supersedes` names a missing id fails the foreign key; inserting two rows with the same `supersedes` fails the unique index; `schema_version` lists `module:nanoclaw.handoff-ledger:supersedes` exactly once and re-running migrations is a no-op.

`src/modules/handoff-ledger/slack-enforcement.test.ts`
- **B1** `a revision handoff message must carry the SUPERSEDES line that matches the ledger` — row with `supersedes: 'H-1'`: message with `SUPERSEDES: H-1` → `action === 'allow'` and `beforeForward` calls `deliverWithInputs`; message without `SUPERSEDES` → `action === 'drop'`, reason contains `SUPERSEDES does not match the trusted ledger`, notifier called with that reason and the id; message with `SUPERSEDES: H-9` → same rejection.
- **B2** `a first-round handoff message must not claim SUPERSEDES` — row `supersedes: null`, message with `SUPERSEDES: H-1` → drop with the same reason.

`src/cli/resources/handoffs.test.ts`
- **C1** `ncl handoffs create forwards --supersedes to the ledger` — the ledger receives `supersedes` and the returned row shows it.

`src/cli/resources/missions.test.ts`
- **D1** `a superseded handoff is labeled superseded with no next action` — stage `superseded`, next action `none`, excluded as terminal beyond the recent window.
- **D2** `changes_required and review_blocked next actions name the --supersedes revision` — strings contain `--supersedes`.
- **D3** `a revision and its prior render as one thread` — with prior `H-1` (`changes_required`) and successor `H-2`, the mission list contains both rows; `H-2.revises === 'H-1'`, `H-1.stage === 'superseded'`; a first-round row and a task row have `revises === ''`; the `revises` field is declared in the resource field list.

`src/modules/handoff-ledger/stall-ping.test.ts` (new; fake `deliver`, fake owner/DM resolution, controlled `now`)
- **E1** `pings the owner once for a handoff stalled past the threshold` — `delivered` row aged 7 h: exactly one `deliver` call whose text contains the id, `delivered`, and `7 hours`; one `owner_pinged` event with matching `status`/`updated_at`/`recipient`; a second sweep makes no call.
- **E2** `does not ping closed or superseded handoffs` — aged `closed` row and aged `changes_required` row with a successor: zero calls, zero events.
- **E3** `review_blocked pings after one hour and other open statuses after six` — at 2 h: `review_blocked` pinged, `delivered` not; at 7 h: `delivered` pinged.
- **E4** `pings again when the handoff moves to a new stalled state` — after a ping, transition `delivered → changes_required`, age 7 h: a second ping with the new status; a third sweep makes no call.
- **E5** `a delivery failure records no event and is retried on the next sweep` — `deliver` throws once: no event, warning logged; next sweep with a working `deliver`: exactly one call and one event.
- **E6** `does nothing without an owner DM or delivery adapter` — no throw, no calls, no events.
- **E7** `the message names who is waiting and the next action` — for each open status the text contains the mapped `Waiting on:` value and `ncl handoffs get --id <id>`.
- **E8** `a handoff that changes between the scan and the send is not pinged` — fake `deliver` for the first handoff transitions the second handoff (`delivered → approved`) before returning; the second handoff gets no `deliver` call and no event in that sweep.
- **E9** `a failed event append after a successful send yields one duplicate, not a silent miss` — `recordOwnerPing` throws once after `deliver` succeeds: error logged, no event; next sweep sends exactly one more message and records one event; a third sweep sends nothing.
- **E10** `each owner is deduplicated separately` — two owners with DMs; `deliver` fails for the second only: one event with `recipient` = first DM; next sweep sends only to the second and records its event; a third sweep sends nothing.

## 6. Implementation path and ownership

Single builder (one cohesive write set; no parallelism). Order:
1. Materialize A1–A10, B1–B2, C1, D1–D3, E1–E10 as failing tests; run once, record the failures in `run.md`.
2. `migration.ts` v2; `ledger.ts` (`HandoffRow.supersedes`, `canonical`/`fingerprintOfRow` conditional ninth key, `createHandoff` validation and events, `recordOwnerPing`, export `superseded`/`owner_pinged` event names).
3. `slack-enforcement.ts` SUPERSEDES binding.
4. `handoffs.ts` `--supersedes`; `missions.ts` labels.
5. `stall-ping.ts`; `host-sweep.ts` hook; `handoff-ledger/index.ts` import.
6. `projects/shared-protocol.md`, `projects/echo/review-policy.md`, both personas (with backups).
7. Fresh checks (§8), diff inspection, `run.md` evidence, commit on `production`.

Files owned: `src/modules/handoff-ledger/{migration.ts, migration.test.ts, ledger.ts, ledger.test.ts, slack-enforcement.ts, slack-enforcement.test.ts, stall-ping.ts, stall-ping.test.ts, index.ts}`, `src/cli/resources/{handoffs.ts, handoffs.test.ts, missions.ts, missions.test.ts}`, `src/host-sweep.ts` (hook block only), `projects/shared-protocol.md`, `projects/echo/review-policy.md`, `groups/dm-with-kobe/instructions.prepend.md`, `groups/quiverchat/instructions.prepend.md`. Nothing under `src/modules/verifier/` changes.

## 7. Rollout, rollback, safety

Rollout: build on the `production` branch; `pnpm typecheck && pnpm build`; host restart (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-eacf8390`) applies the migration (log line `Migration applied name=module:nanoclaw.handoff-ledger:supersedes`); Echo and Atlas pick up persona changes at next spawn; the protocol file is a read-only mount and is live immediately.

Rollback: revert the commit, rebuild, restart. The `supersedes` column, the index, and any `superseded`/`owner_pinged` events stay in the database and are inert for the previous code (nullable column ignored by `SELECT *` consumers; unknown event types are never interpreted by the verifier or the ledger). Persona backups restore with `cp`. Migration is one-way by design; stated justification: SQLite column drops are avoidable here because the column is nullable and unread by old code.

Safety: only the source agent group can create a revision (existing `createHandoff` caller identity, CLI agent callers are always themselves); Echo cannot supersede Atlas's work; the reviewer branch of enforcement is untouched so review recording is unchanged; the ping never includes message bodies, only ids, project, status, and age; the ping goes only to users with the `owner` role and only to their existing DM group.

## 8. Verification commands

```
pnpm exec vitest run src/modules/handoff-ledger src/cli/resources/handoffs.test.ts src/cli/resources/missions.test.ts
pnpm typecheck
pnpm build
grep -n "MODULE-HOOK:handoff-stall-ping" src/host-sweep.ts
```
Live after restart: `grep "handoff-ledger:supersedes" logs/nanoclaw.log`; Brian's DM receives the pings listed in §4.2; `ncl handoffs events --id RECOVERY-20260909-ATLAS-ECHO` shows `owner_pinged`; Atlas runs `ncl handoffs create --supersedes handoff-1789503177574-b2315abc …` and `ncl handoffs events --id handoff-1789503177574-b2315abc` ends with `superseded`.

## 9. Risks and decisions

- **Thresholds (1 h blocked, 6 h open) and once-per-stall** are my defaults, chosen so Brian is told within a working session but not nagged. Tunable constants; not a blocker. Brian may override at approval.
- **At-least-once pings.** A duplicate is possible only on a crash or Slack timeout between send and record (§4.2 step 8). Accepted over an outbox table; revisit only if duplicates are observed in practice.
- **Residual stale-state window** between the pre-send re-read and the Slack call (§4.2 step 6) is bounded by one network round trip and carries the state it describes. Accepted.
- First tick after restart will send three or four pings for rows that have been sitting for days. Expected and useful; noted so it is not mistaken for a bug.
- A revision whose prior is `review_blocked` because of a verifier infrastructure error will run the verifier again on the new id; that is the intended path.
- The `superseded` event is appended by the source's create call; if the prior is revised while Echo is mid-`run_checks` on the prior, the verifier's identity snapshot does not include events, so the in-flight run is unaffected and the prior's status is unchanged. Acceptable; the prior is terminal anyway.
- Unresolved: none that block approval.
