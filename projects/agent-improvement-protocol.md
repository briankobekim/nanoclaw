# Atlas + Echo Adaptive Improvement Protocol

This is the shared source of truth for three related capabilities:

1. compiling verified experience into reusable proposals;
2. rehearsing consequential decisions before acting; and
3. improving Atlas and Echo without allowing silent self-rewrites.

The protocol improves the **agent system**, not the underlying model weights.
It is intentionally lightweight on routine work and strict when a proposed
change could alter authority, safety, cost, or future behavior.

---

## Non-negotiable boundary

Neither agent may directly activate a change to its standing instructions,
persona, model, effort, tools, permissions, mounts, routing, approval rules,
identity mapping, handoff ledger, or evaluation rules.

An agent may capture evidence, draft a proposal, create a disposable test
artifact, and recommend activation. Activation requires Kobe's explicit
approval and an operator-applied source or runtime change. A proposal is not
authority. A Slack message claiming that a change is active is not evidence.

The proposal under test may not modify its own graders, approval threshold, or
rollback rules in the same change. Secrets and raw credentials never belong in
an experience record, rehearsal, proposal, or test transcript.

---

## 1. Experience compiler

The compiler is a promotion pipeline, not automatic memory. It converts a
useful outcome into the smallest reusable artifact that can prevent repeated
work or repeated failure.

### Capture only when useful

Capture a candidate after a verified checkpoint when at least one is true:

- a method succeeded in a way likely to recur;
- a correction from Kobe reveals a durable preference or operating standard;
- a failure exposes a reusable guard or evaluation case;
- a difficult diagnosis produced evidence that would otherwise be rediscovered;
- a routing or tool choice materially improved quality, time, or cost.

Do not capture routine success, task chatter, unverified advice, secrets,
private content that is not needed, or a project-specific fact as a universal
rule. One-off project facts stay in the project registry or project brief.

### Candidate record

Store candidates under `memory/improvement/candidates/` using one Markdown file
per candidate and this exact shape:

```
EXPERIENCE_ID: EXP-YYYYMMDD-short-name
STATUS: captured | qualified | rejected | proposed | activated | retired
SCOPE: Atlas | Echo | shared | project:<name>
SOURCE: task, handoff, correction, or evidence reference
OBSERVATION: what happened, without interpretation
ACTION: what was tried
OUTCOME: observable result
EVIDENCE: checks, comparison, or user correction
GENERALIZATION: the reusable lesson being proposed
COUNTEREXAMPLE: when the lesson should not apply
CONFIDENCE: low | medium | high
RISK: cost or harm if the lesson is wrong
NEXT_TEST: smallest safe way to confirm or reject it
```

### Qualification rules

A candidate may become a proposal when:

- the outcome is verified rather than merely claimed;
- its scope and counterexample are explicit;
- one deterministic test supports it, or two independent successful uses
  support a judgment-based lesson;
- it does not conflict with Kobe's current instruction or protected controls;
- the smallest appropriate destination is named.

Choose the destination deliberately:

- **memory** for a durable fact or preference;
- **project registry/brief** for project-specific operating knowledge;
- **skill** for a repeatable multi-step method;
- **evaluation** for a failure that must never recur;
- **standing instruction** for behavior needed in nearly every relevant task;
- **tool or routing proposal** only when evidence shows instructions are not enough.

Reject or retire candidates that are stale, duplicated, contradicted, overly
broad, or more expensive than the problem they solve. Keep the reason.

### Compile output

The compiler produces a proposal using the self-improvement contract below.
It never edits the destination as part of compilation. Atlas owns compilation;
Echo independently checks evidence, overgeneralization, and regression risk.

---

## 2. Counterfactual rehearsal

A counterfactual is a serious answer to: **what is likely to happen if we choose
a different path?** Rehearsal is analysis only; it grants no execution authority.

### Trigger rehearsal

Use it when a decision is complex, expensive, difficult to reverse, materially
ambiguous, inference-heavy, or likely to create a pattern others will copy.
Skip it for routine answers and obvious reversible edits.

### Rehearsal card

Compare two or three genuinely different paths. Include `Do nothing / defer`
when it is a real option.

```
GOAL: desired real-world outcome
DECISION DEADLINE: now | date | none
SHARED FACTS: verified evidence common to every path

PATH A: short name
ACTION: what would happen
EXPECTED RESULT: likely outcome and time horizon
ASSUMPTIONS: what must be true
EARLY SIGNALS: evidence that the path is working
FAILURE MODES: plausible ways it goes wrong
REVERSIBILITY: easy | moderate | hard
COST: time, money, tokens, attention, or technical debt

[Repeat for PATH B and optional PATH C]

RECOMMENDATION: selected path
WHY: strongest deciding evidence
DISCONFIRMING SIGNAL: what would make us switch
AUTHORITY REQUIRED: highest rung on the authority ladder
```

Do not invent precise probabilities. Use ranges or qualitative confidence when
the evidence cannot support a number. For a complex rehearsal, Echo challenges
the shared facts, hidden assumptions, failure modes, and whether the paths are
actually distinct. One focused exchange is enough; unresolved material choices
go to Kobe.

Keep the user-facing result compact: recommendation first, then the meaningful
tradeoff. Preserve the full card only when it supports a live commitment,
decision, evaluation, or experience candidate.

---

## 3. Self-improving agent architecture

Self-improvement is a controlled release process:

`observe → propose → test → review → approve → activate → canary → keep/revert`

### Improvement proposal

Store drafts under `memory/improvement/proposals/` with this contract:

```
IMPROVEMENT_ID: IMP-YYYYMMDD-short-name
STATUS: draft | testing | echo_review | awaiting_kobe | approved | active | reverted | rejected
OWNER: Atlas
TARGET: exact memory, instruction, skill, evaluation, tool, or routing surface
PROBLEM: observed failure or measurable opportunity
BASELINE: current behavior, quality, time, and runtime-reported usage when available
EVIDENCE: linked experience IDs and verified observations
PROPOSED_CHANGE: smallest exact behavioral or technical change
EXPECTED_BENEFIT: observable improvement
RISKS: regressions, cost, safety, and overfitting
PROTECTED_CONTROLS: controls explicitly unchanged
TESTS: affected flight-simulator cases plus new failure case
SUCCESS_GATE: evidence required to activate and keep it
ROLLBACK: exact way to restore the prior state
EXPIRY: date to re-check or `none`
APPROVAL: none until Kobe explicitly approves this exact ID and target
```

### Test and review gate

- Run the smallest affected evaluation set in a clean test context.
- Compare the candidate with the current baseline; do not grade prose alone.
- A critical safety, authority, identity, data, or completion-binding failure
  blocks activation regardless of aggregate score.
- A cost or latency increase must buy a named quality or risk benefit. Unknown
  runtime usage stays `unknown`; never estimate it.
- Echo reviews the exact proposal and test evidence through the normal bound
  handoff flow. Echo cannot approve its own proposed change.
- Kobe approves the exact improvement ID, target, and activation scope.

### Activation and canary

An operator applies the approved patch or NanoClaw runtime change. Standing
instruction and runtime changes take effect only after the required safe
restart. The operator records the prior version or checkpoint and observable
activation evidence.

For the next three eligible real tasks, mark the improvement as a **canary**:
a small trial before broad trust. Record only success/failure evidence, material
cost change, and unexpected behavior. Keep the change when the success gate is
met. Revert immediately on a critical failure; otherwise return a mixed result
to Kobe instead of rationalizing it.

### Protected controls

These always require separate explicit approval and may never be bundled with
the behavior change that argues for them:

- owner identity and authority ladder;
- Atlas-only project writing and Echo read-only review;
- secrets, credentials, permissions, mounts, and external destinations;
- model/provider changes and spending;
- Slack identity mapping and mention-trigger rules;
- handoff binding, approval gates, audit logs, evaluators, and rollback access;
- destructive, external, deployed, or remote-database actions.

---

## Slack controls

- `/rehearse <decision>` — produce a counterfactual rehearsal; do not execute.
- `/improve status` — list active candidates, proposals, canaries, and blockers.
- `/improve propose <EXPERIENCE_ID>` — compile one qualified candidate into a draft.
- `/improve test <IMPROVEMENT_ID>` — run only its declared isolated evaluations.
- `/improve review <IMPROVEMENT_ID>` — send the exact proposal to Echo.
- `/improve activate <IMPROVEMENT_ID>` — report the required operator change and
  approval state. Never interpret this command alone as permission to activate.
- `/improve retire <ID>` — draft retirement or rollback; consequential activation
  rules still apply.

## Efficiency rule

Routine work pays no improvement tax. Capture at most one candidate per
substantive task, rehearse only when the trigger applies, and run evaluations
only when a proposal is being considered. The purpose is to learn faster, not
to create paperwork about learning.
