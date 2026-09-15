# Atlas/Echo runtime recovery — 2026-09-09

Status: runtime restored; one live test completed with HANDOFF DELIVERY BLOCKED. End-to-end handoff did not pass.

## Scope and cause

User approved recovery with “go” after the readiness report. Runtime recovery
only: no adaptive-agent protocol transfer, model change, permission expansion,
project work, dependency install, rebuild, commit or deployment.

The old launchd service was repeatedly exiting with MODULE_NOT_FOUND for
/Users/kobekim/Documents/GitHub/nanoclaw/dist/index.js. The original directory
now contained only crash logs; the actual checkout moved to
/Users/kobekim/Documents/Documents - Kobe’s MacBook Air/GitHub/nanoclaw.
Docker was also unreachable at its configured socket.

Used Bootstrap evidence-first debugging. A read-only worker independently
traced authoritative DB mounts, queued startup work, and the existing test route.

## Applied recovery

1. Started the existing Docker app; OneCLI and its PostgreSQL container returned
   healthy. Stopped only the NanoClaw crash-loop registration before editing.
2. Saved private rollback copies under rollback/ (directory mode 0700,
   git-ignored). Saved original service plist SHA256:
   3cee28ad1f4edf3ca65ebec054f45827b04b3257c3e7008ac717f351b7ae30e9.
   Stopped central DB snapshot:
   04ef376ed7bb360004c71446d48f81b8e78ec9945b01ee13c2789d8418c73bea.
   Original mount allowlist:
   8a3604bc3b0a50edfaa32735a177301796184983fc9fdbe38fd71984b15fc834.
   The stopped DB WAL was zero bytes before backup.
3. Replaced exactly four service path strings: executable script, working
   directory, stdout log, stderr log. Original service label
   com.nanoclaw-v2-eacf8390 and other fields remain unchanged.
4. Replaced exactly two allowed-root paths: QuiverIQ agent checkout and shared
   projects. All access flags and other fields remain unchanged; the unrelated
   old illysium root was not changed.
5. Through the existing dist DB helper, transactionally remapped only the two
   agents’ additional_mounts and updated_at. Every other column was compared
   before/after and preserved. Atlas retains QuiverIQ RW, Echo RO; both shared
   projects mounts remain RO. Group IDs, models, effort and credential bindings
   are unchanged. No migration was run by the repair helper.
6. Relocation changes the path-derived install slug from eacf8390 to44a1d5b3.
   Added the image alias nanoclaw-agent-v2-44a1d5b3:latest pointing to exactly
   the existing image SHA256:
   211c7a472356e4bc2e240493a606d55280527fe158d7e78c37d5c32b1ba3453c.
   No image was rebuilt/downloaded; the original tag remains.
7. Ran the new read-only scripts/check-atlas-echo-paths.mjs preflight and started
   the repaired service. Kept existing compiled dist unchanged rather than
   rebuilding unrelated dirty source changes.

## Verified results

- plutil lint: OK.
- Exact semantic plist and allowlist comparison to backups: path substitutions
  only, no access or environment-field changes.
- node --check scripts/check-atlas-echo-paths.mjs: pass.
- Read-only preflight: both agents’ mounts/access, service files/logs, and image pass.
  This retained diagnostic catches a repeat path relocation before startup.
- launchctl: running, one run, PID49603, never exited at initial recovery check.
- Both Slack bot identities authenticated and both Socket Mode connections
  connected at19:38:52 local. NanoClaw admin socket responds with Atlas and Echo.
- Atlas live test container mounts inspected: relocated shared projects RW=false,
  relocated QuiverIQ agent checkout RW=true.
- Existing unsupported nonMainReadOnly allowlist key warning is preserved;
  per-root and per-mount access flags are the actual controls inspected.
- Earlier log network warnings are historical; they were not misreported as
  new recovery failures.

## Startup backlog and bounded test

A read-only audit found one overdue, existing weekday morning brief, no
processing messages and no undelivered outbound messages. Its saved scope is
read-only gathering and a short DM to Kobe, with QuiverIQ paused. User was told
it may resume. Its schedule and prompt were not edited.

Dispatched exactly one immediate, nonrecurring test via the existing native
tasks interface:
- series: recovery-handoff-smoke-64c0
- session: sess-1788997203313-miunqd
- requested handoff: RECOVERY-20260909-ATLAS-ECHO
- project: none
- content: review only “2 + 2 = 4”
- destination: existing coordination room C0BRXHH00CR; not claimed private
- allowed activity: this test’s ordinary handoff/task audit records and messages
- prohibited: project reads/edits, browsing, deployments, memory/instruction
  changes, new schedules, retries or self-repairs
- success: authenticated delivery, Echo’s bound review, Atlas acknowledgement
  and verified closure of the exact fingerprint
- no simulated test is counted as an adaptive-agent canary observation

At the intermediate check Atlas had started and created the handoff record;
completion remained unverified.

## Rollback boundaries

If recovery must be reversed, stop this service first. Restore original plist
and allowlist from the local backups. Restore only the two prior mount JSON
values and timestamps (Atlas2026-08-23T15:45:05.801Z,
Echo2026-08-23T15:45:09.771Z) after checking for intervening configuration edits.
Do not overwrite the whole live DB snapshot after new session/audit work.
Old mount values are the original /Users/kobekim/Documents/GitHub roots with
all access flags unchanged. Keep the new audit records. The old source paths
are broken, so restoring them does not mean the old service can run.
The added image alias is reversible without deleting the original image/tag.
Docker/OneCLI may now serve other workloads; do not shut them down blindly.

## Final live test result

- One nonrecurring run completed; zero retries and zero task execution failures.
  Scheduler completion is NOT handoff success.
- Atlas created RECOVERY-20260909-ATLAS-ECHO at2026-09-09T23:41:10.472Z.
- Fingerprint:79b092151246e73ff596a82f67756ddbf2347342fea6120469d1038c554b0f34.
- Slack transport accepted message1788997280.852659 in C0BRXHH00CR.
  Host delivery evidence is logs/nanoclaw.log:2453 (19:41:20 local).
- Echo's inbound handoff interceptor rejected it at19:41:21.292 local:
  “missing HANDOFF_ID”, logs/nanoclaw.error.log:5083.
- Worker inspected the stored outbound test package: it contains HANDOFF_ID and
  the other required fields. Lead verified the exact ledger and host rejection.
  The exact transformation/parsing cause is not yet proven.
- Ledger remains created, review_outcome=null, closed_at=null. No delivered,
  reviewed, acknowledged or closed event exists. Atlas reported the blocker
  and stopped as instructed.
- This proves live Atlas provider execution, CLI access, record creation and
  outbound Slack delivery. It does not prove Echo model execution or a complete
  review round-trip.
- No second probe, parser change, manual approval/delivery transition, or claimed
  canary observation was made.

The next scoped repair is to reproduce the receiver's HANDOFF_ID loss using
the actual sent/received representation, fix that parsing boundary without
weakening identity/fingerprint validation, and rerun one bounded live exchange.
Runtime path recovery is complete; end-to-end coordination remains blocked.
The separate adaptive-agent protocol transfer has not been performed.
