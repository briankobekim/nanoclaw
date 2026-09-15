# Atlas + Echo Shared Working Protocol

Reference material shared by both agents. Atlas and Echo each carry their own
standing instructions; this file holds the definitions they must agree on, so
there is one source instead of two drifting copies.

Read this file when you need a definition from it — classifying a task, sending
or receiving a handoff, or choosing a verification depth. The safety rules that
must always apply (single-writer, room engagement, approval boundaries) live in
each agent's own standing instructions, not here.

Adaptive learning, counterfactual rehearsal, and controlled self-improvement
are defined in [`agent-improvement-protocol.md`](agent-improvement-protocol.md).
That protocol is subordinate to the safety and authority rules here: a lesson,
rehearsal, or improvement proposal never grants execution authority.

---

## Task classes

Every task and every review is classified `simple`, `standard`, or `complex`.
The class drives model tier, verification depth, and how much scope may move
without a new approval.

Classify by the strongest signal that applies, not by how long the work feels.

**`simple`** — all of these hold:
- One file, or several files changed the same mechanical way.
- No behavior change a user could observe, or a change so small it has one obvious correct outcome.
- Trivially reversible: undoing it is deleting the change.
- No security, auth, payment, migration, or data-integrity surface.

Examples: renames, copy edits, formatting, a comment, a version bump with no API change, adding a test for existing behavior.

**`standard`** — the default. Any of these:
- Observable behavior changes, but inside one established pattern or component.
- Touches several files that must stay consistent with each other.
- A user could notice if it were wrong, but nothing is lost permanently.

Examples: a new component matching existing ones, a bug fix with a clear reproduction, a new endpoint following existing conventions, a UI change on one route.

**`complex`** — any single one of these is enough:
- Architecture, a new abstraction, or a pattern others will copy.
- Security, authentication, permissions, payments, or personal data.
- Schema or migration work, or anything that can lose or corrupt data.
- Recommendation, scoring, or ranking logic that shapes what a user is told.
- A cause that is not yet understood — debugging without a confirmed diagnosis.
- Hard or slow to reverse once shipped.
- Meaningful new technical debt, or debt being deliberately accepted.

**Disagreement rule.** Echo may re-classify any task. When Atlas and Echo
disagree, the higher class wins and the work is verified at that level. Neither
agent argues the classification past one exchange — escalating costs less than
under-verifying. Either agent may ask Kobe to overrule.

---

## Verification ladder

Verify in proportion to class. Match the check surface to the changed surface —
a narrow change does not earn a full-repository check.

- **`simple`** — the smallest focused check that proves the change.
- **`standard`** — focused tests, plus the relevant type, lint, build, interaction, or data-integrity check.
- **`complex`** — the critical scenarios, the failure path, regression risk, security and data implications, and the rollback or recovery path where one applies.

**Visual work, any class.** Comparing source alone is never verification of a
visual change. Both agents:

- Take preview addresses and design rules from the project's registry entry.
- Exercise every changed control and route; check the relevant desktop and phone layouts, console errors, navigation, and asset loading.
- Compare the rendered result against Kobe's request and the project's established design language, not just the diff.
- Iterate on visible problems before reporting completion.

Atlas re-checks the route after fixing a visual finding; Echo re-opens the route
to verify the correction. If the preview is unreachable, Echo returns
`REVIEW BLOCKED — PREVIEW` rather than approving from code inspection alone.

**Nonvisual work.** No screenshots and no browser unless they materially prove
the result, or Kobe asks.

Never claim success from code inspection alone when the behavior can actually be
exercised.

---

## Outcome contract and evidence

Before substantive work, Atlas states a compact outcome contract:

- **Desired result** — the real-world change Kobe wants, not merely the task performed.
- **Success evidence** — what observable proof will show it worked.
- **Boundaries** — what is in scope, out of scope, and deliberately unchanged.
- **Authority** — the highest approved action level: `observe`, `recommend`, `draft`, `queue`, `execute`, `monitor`, or `close`.
- **Follow-up owner** — who watches the result and what condition closes the loop.

For simple work this may be one sentence. Standard and complex work carries these fields in the handoff.

Both agents keep claims in four evidence classes:

- **Verified fact** — directly observed in a reliable source or exercised behavior.
- **Inference** — a conclusion drawn from facts; state the reasoning.
- **Assumption** — temporarily treated as true so work can proceed; name it.
- **Unknown** — not yet known; state what evidence would resolve it when material.

Do not quietly upgrade an inference or assumption into a fact. For an action with meaningful side effects, use a dry run or preview when one exists before execution.

### Review triggers

Echo review is required for complex work and for security, authentication, data integrity, external communications, expensive or hard-to-reverse actions, patterns others will copy, and decisions resting heavily on inference. Review is selective for standard work and normally skipped for routine simple work.

---

## Handoff contract

One field list. Atlas emits it; Echo validates it on receipt. Same names on both
sides so a missing field is mechanically detectable.

```
HANDOFF_ID:   unique stable ID for this review item
FINGERPRINT:  exact SHA-256 fingerprint returned by `ncl handoffs create`
PROJECT:      registered project name, or "none"
GOAL:         what this change is meant to accomplish
OUTCOME:      desired real-world result and observable success evidence
CLASS:        required token, ^[a-z][a-z0-9-]{0,31}$ — simple | standard | complex
SCOPE:        what was approved, and what was deliberately left out
AUTHORITY:    highest approved level on the action ladder
CHECKPOINT:   git commit hex the checks run against, ^[0-9a-f]{7,40}$
FILES:        changed files
CHECKS:       JSON array of command strings, one logical line
REPRODUCE:    JSON array of reproduction steps, documentation only (never run)
EVIDENCE:     verified facts, inferences, assumptions, and material unknowns
RISKS:        known risks, evidence gaps, and decisions needing review
FOLLOW_UP:    next owner, next action or monitoring condition, and closure test
```

`CLASS` is always one of the three task classes above, written as the required
token `^[a-z][a-z0-9-]{0,31}$`; the host rejects anything else.

`CHECKPOINT` is the exact git commit hex, `^[0-9a-f]{7,40}$`, that `CHECKS`
must run against — this is what `run_checks` (see Verification, below) checks
out before executing anything. `CHECKPOINT`, `FILES`, and `CHECKS` may all be
`n/a` together, only for a non-code decision review with no runnable surface
and nothing for `run_checks` to execute. Whenever `CHECKS` is populated,
`CHECKPOINT` is required and must match the commit the work actually landed
on.

`CHECKS`, when populated, is a JSON array of 1–10 command strings, encoded on
one logical line, e.g. `CHECKS: ["pnpm test", "node scripts/smoke.js"]`. Each
command is at most 1,000 bytes; the array's total encoded size is at most
32 KB. These are the commands `run_checks` will execute, not a report of
commands Atlas already ran — the host is the one that runs them, at
`CHECKPOINT`, in an offline sandbox.

`REPRODUCE` is a JSON array of reproduction-step strings and may be `[]` for
nonvisual work with no runnable surface — never the bare string `"n/a"`.
`REPRODUCE` is documentation only and is never executed: the verifier records
the steps verbatim and prints them under a heading that says so, and runs none
of them. There is no REPRODUCE exit code, so it is never a pass/fail
signal — a reproduction step that needs to be run is a `CHECKS` command.

Every field other than the `CHECKPOINT`/`FILES`/`CHECKS` non-code exception
above is required.

Example of the four changed fields on the wire:

```
CLASS:      standard
CHECKPOINT: 4f2a9c1e83
CHECKS:     ["pnpm test", "node scripts/smoke.js"]
REPRODUCE:  ["Open /dashboard", "Click Export", "Confirm the CSV downloads"]
```

A non-code decision review with nothing to run:

```
CLASS:      simple
CHECKPOINT: n/a
CHECKS:     n/a
REPRODUCE:  []
```

If a required field is missing or empty, Echo returns
`REVIEW BLOCKED — INCOMPLETE HANDOFF` and names the missing fields, rather than
guessing or inspecting to fill the gap itself.

`HANDOFF_ID` is the package tracking number for the review. `FINGERPRINT` is the
digital barcode of its immutable contents. Before sending the handoff, Atlas
creates the ledger record with `ncl handoffs create`. In an allowlisted Slack
A2A room, NanoClaw intercepts the formal package, authenticates both bots,
checks every required field against the ledger, and changes `created` to
`delivered` before Echo receives it. Atlas does **not** run `handoffs deliver`
on that path; it runs `ncl handoffs get --id <id>` after posting and requires
`status: delivered` as proof that interception succeeded.

Echo validates the delivered row, performs the review, and posts the bound
handback without running `handoffs review` first. NanoClaw intercepts that
message, validates its exact ID, fingerprint, project, goal, direction, and
formal outcome, then records the review before Atlas receives it. Echo checks
the row after posting; unchanged `delivered` state means the handback was
blocked. Manual `deliver` and `review` commands are recovery/admin tools for
non-Slack paths, not the normal Slack workflow. Atlas still records
`acknowledge` and `close` after receiving an approved exact match.

The ID alone is not enough. Echo also repeats `FINGERPRINT`, `PROJECT`, and `GOAL`. Atlas closes
the item only when the current session contains the original handoff body with
the same ID, or the trusted handoff ledger supplies that exact binding. A task
is not closed until `ncl handoffs close` returns `status: closed`. If the binding
or ledger transition is unavailable, Atlas returns `REVIEW BINDING BLOCKED`,
leaves all work open, and reports the routing gap to Kobe.

---

## Verification

Formal review of a delivered handoff is executed by the host, not by either
agent running scripts or trusting the other's self-report.

- Echo verifies by calling the `run_checks({ handoff_id })` tool and waiting
  for the host's system-message reply. Echo never runs the checks or any
  `CHECKS` command itself — the host runs them, extracted from an archive of
  the handoff's exact `CHECKPOINT`, one disposable offline read-only container
  per check, each container force-removed and confirmed gone before the next
  check starts.
- Only a handoff whose ledger status is `delivered` can be verified. A
  `run_checks` call against any other status — `created`, `changes_required`,
  `closed`, or unknown — is refused by the host; Echo reports the refusal by
  name rather than treating it as a failing check.
- The host writes and hashes the canonical evidence record and returns its
  headline in the system message: the host-derived `verdict`, an
  `error_reason` when the run was stopped early, and one line per check
  carrying that check's `exit_code`, whether it `timed_out`, and whether
  docker confirmed its container was removed. The `record_sha256` is
  host-attested — computed by the host over the bytes it wrote, never read out
  of anything a container printed — and is the value Echo quotes in a review.
  A hash either agent produced itself is never a substitute.
- `REPRODUCE` is documentation only and is never executed. It is stored,
  fingerprinted and recorded, and the system message lists it under
  `REPRODUCE (documentation only, not executed)` with no exit code beneath it.
  It never reaches a container's argv or stdin. Nothing in that section is a
  check, and neither agent may cite it as one.
- `APPROVED` and `APPROVED WITH MINOR NOTES` require the host's
  `verdict: ALL_CHECKS_PASSED` — every frozen check `ran`, exited 0, did not
  time out, and had its container's removal confirmed — and the review to
  quote the host-attested `record_sha256` plus one line per check.
  `CHANGES REQUIRED` names the failing command, its `exit_code`, and the
  relevant recorded output. Any `VERIFIER_ERROR` is REVIEW BLOCKED: the frozen
  list was not finished under proven isolation, so name its `error_reason`
  instead of reading the checks that did run as a result.
- A `changes_required` outcome is never resubmitted against the same handoff.
  Atlas makes the fix, then creates a brand-new `HANDOFF_ID` with a freshly
  captured `CHECKPOINT`, `CHECKS`, and evidence; the original handoff stays
  closed against its own failed verification. `run_checks` verifies an ID
  exactly once — never an ID that was already verified, and never one that
  was never `delivered`.

---

## Compact task receipt

After substantive work reaches a verified checkpoint, Atlas gives Kobe one
compact receipt. This is the human-facing proof of what happened; it does not
replace the Atlas-to-Echo handoff.

```
HANDOFF_ID:   matching handoff ID, or "n/a" when no Echo handoff existed
FINGERPRINT:  matching ledger fingerprint, or "n/a"
TASK:         short name
RESULT:       complete | partial | blocked
CLASS:        simple | standard | complex
AUTHORITY:    highest action level actually used
ACTIONS:      material actions taken, or "none"
APPROVALS:    approvals used, or "none"
EVIDENCE:     observable proof of the result
TIME:         elapsed time, or "unavailable"
USAGE:        model plus tokens/cost when reported by the runtime; otherwise "unavailable" and why
NEXT:         next owner and closure/follow-up condition, or "closed"
```

Keep it short. Never invent elapsed time, tokens, or cost. `RESULT: complete`
requires outcome evidence; a sent request or another agent's claim is not enough.

---

## Review outcomes

Echo returns exactly one state:

- `APPROVED`
- `APPROVED WITH MINOR NOTES`
- `CHANGES REQUIRED`
- `REVIEW BLOCKED` — with the concrete blocker (`— PREVIEW`, `— INCOMPLETE HANDOFF`, `— ACCESS`, `— USAGE LIMIT`)

The outcome must be on its own line, either as the bare token (`CHANGES REQUIRED`) or
labeled exactly as `FORMAL REVIEW OUTCOME: CHANGES REQUIRED`. Any other wording is not
recognized by the ledger and the review is not recorded.

`APPROVED`, `APPROVED WITH MINOR NOTES`, and `CHANGES REQUIRED` for code work
follow the evidence rules in Verification, above, including quoting the
host-attested `record_sha256` and, on `CHANGES REQUIRED`, requiring a new
handoff rather than a resubmission of the same one.

In a shared Slack room, Echo begins a review intended for Atlas with Atlas's
actual mention, `<@U0BSP5T2JP2>`. A display-name reference alone is not a routed
handoff. Immediately after the mention, Echo includes the exact `HANDOFF_ID`,
`FINGERPRINT`, `PROJECT`, and `GOAL` from Atlas's handoff, then the formal outcome. Delivery is
verified only when Atlas acknowledges or replies to that same bound item.

### Finding severities

Order findings by severity, with exact file and line references where possible.

- `P0` — immediate security, data-loss, or production-stop risk
- `P1` — material correctness, regression, architecture, or user-trust problem
- `P2` — meaningful maintainability, test, evidence, performance, or UX weakness
- `Note` — optional improvement or design preference; does not block approval

Every blocking finding states the consequence, the evidence, and a practical
correction. On approval, state what was inspected and what evidence supports it.

Keep a real defect, a strategic or technical-debt concern, an evidence gap, and
personal design taste clearly separated — they are not the same claim.

---

## Escalating a disagreement

Atlas and Echo are CTO-level peers. Attack weak assumptions and weak work, not
the person. Banter is welcome; indefinite debate is not.

If a material disagreement survives one focused exchange, stop and give Kobe the
options, the consequences of each, and each agent's recommendation. Do not keep
trading messages to convergence.

---

## New-project onboarding template

Copy into `registry.md`, fill every field, and add the channel to the routing
table at the top of that file.

```
- **Project name:**
- **Status:** active | paused
- **Slack channel:** name + channel ID
- **Purpose:**
- **Workspace inside Atlas:**
- **Workspace inside Echo:**
- **Atlas access:** read-write
- **Echo access:** read-only
- **Working branch:**
- **Required project brief:**
- **Development command:**
- **Focused-check command:**
- **Full-check command:**
- **Private preview:**
- **Kobe-facing preview:**
- **Approval boundaries and project-specific rules:**
```
