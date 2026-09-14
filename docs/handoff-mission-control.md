# Handoff ledger and mission control

NanoClaw can bind an agent-to-agent review to a durable host-owned record and
show scheduled work and handoffs together without creating another service or
database. The ledger is authoritative for handoff transitions. `ncl missions
list` is a read-only projection over that ledger and the existing task
mailboxes.

## Trusted handoff lifecycle

A handoff moves through one strict path:

```text
created -> delivered -> approved -> acknowledged -> closed
                  \-> changes_required
                  \-> review_blocked
```

The source agent creates, delivers, acknowledges, and closes its handoff. The
named reviewer records the review. Every state change checks the actor, current
state, and SHA-256 fingerprint; every accepted transition appends an event.
Duplicate, stale, wrong-actor, and wrong-fingerprint transitions fail closed.
Slack delivery and review handback use durable five-minute leases attached to
the existing `created` and `delivered` states. Each reservation increments a
persisted generation. Completion and release require that exact generation, so
a late callback cannot mutate a reclaimed attempt. A failed or refused route
releases its reservation immediately; after a host interruption, a stale lease
can be reclaimed by retrying the same authenticated package.

Create a record before sending the review package:

```sh
ncl handoffs create \
  --source <source-agent> \
  --reviewer <reviewer-agent> \
  --project <project> \
  --goal <goal> \
  --outcome <expected-outcome-and-evidence> \
  --scope <included-and-excluded-scope> \
  --authority <approved-authority>
```

Agent callers are automatically the source. Host callers provide `--source`
and must identify the acting agent with `--actor` for later transitions.
`ncl handoffs get --id <id>` returns the fingerprint required by delivery,
review, acknowledgement, and closure. `ncl handoffs events --id <id>` shows the
append-only timeline.

## Slack delivery enforcement

When Slack is installed, bot-authored messages are dropped at the bridge by
default. Bot-to-bot traffic is admitted only for channel IDs listed in
`SLACK_A2A_ROOMS`. `SLACK_A2A_MAX_HOPS` bounds consecutive bot messages and
defaults to 6; a human message resets the room budget.

A formal source-to-reviewer package must contain these line-oriented fields:

```text
HANDOFF_ID: ...
FINGERPRINT: ...
PROJECT: ...
GOAL: ...
OUTCOME: ...
CLASS: ...
SCOPE: ...
AUTHORITY: ...
CHECKPOINT: ...
FILES: ...
CHECKS: ...
REPRODUCE: ...
EVIDENCE: ...
RISKS: ...
FOLLOW_UP: ...
```

The review reply repeats `HANDOFF_ID`, `FINGERPRINT`, `PROJECT`, and `GOAL`,
plus exactly one outcome line: `APPROVED`, `APPROVED WITH MINOR NOTES`,
`CHANGES REQUIRED`, or `REVIEW BLOCKED`.

The bridge prefers Slack's formatted syntax tree so paragraph and list
boundaries remain parseable, while quoted and code-block examples remain
non-executable. Duplicate fields or multiple formal outcomes fail closed. A
constrained fallback recovers a leading
`HANDOFF_ID` only when serialization collapsed that one field and every other
required field is already present. Ordinary conversation and incomplete
examples do not advance the ledger.

Before routing, the source bot identity must map unambiguously to one agent
group across its Slack instance, and the receiver is resolved from the exact
receiving instance and room wiring. The ledger moves from `created` to
`delivered` only when the host router returns a durable receipt naming that
reviewer agent group; access, engagement, and routing failures leave the
handoff retryable. A formal review similarly becomes authoritative only after
the host router confirms receipt by the exact source agent group.

## Mission view

```sh
ncl missions list
ncl missions list --group <agent-name-or-id> --recent-days 30 --limit 50
```

The host view includes all durable handoffs, even when an associated group was
deleted; the group ID is then shown as the owner fallback. `--group` means
_involved group_: it includes that group's tasks plus handoffs where the group
is either source or reviewer. Container callers remain scoped to their own
group.

Stages are conservative. A created handoff, including one with a delivery lease,
is `awaiting_delivery`; a delivered handoff is `ready_for_review`; a delivered
handoff with a review lease is `review_in_transit`; and an approved or acknowledged handoff is
`review_complete`. Review completion does not prove permission to ship, so the
view reports shipping as `unknown` rather than granting it. Pending future
tasks are `queued`. Any field not safely represented by the source record is
shown as `unknown`.

`changes_required`, `review_blocked`, and closed handoffs are terminal for the
recent-history window. Failed, completed, and cancelled tasks are treated the
same way. Mission rows are deduplicated only when a per-series task session is
exactly linked from a handoff; a legacy shared task session never hides its
unrelated series.

## Migration and rollback

The module migration creates `handoffs` and `handoff_events`; it does not
rewrite tasks or existing channel records. On upgrade, build and restart the
NanoClaw host, then run `ncl handoffs list` and `ncl missions list` through the
normal daemon socket.

To roll back the code, restore the previous build and restart the same host
service. Existing ledger tables and rows are left dormant so review history is
not destroyed. Remove `SLACK_A2A_ROOMS` only if bot-to-bot Slack delivery should
also be disabled; without an allowlist, bot-authored inbound remains denied.
