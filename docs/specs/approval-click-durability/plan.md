# Approval-click durability: record the tap before the card loses its buttons

Status: APPROVED by Brian on 2026-09-16 ("Let's go with approval bridge fix and the two small things"); built the same day. Origin: accepted-risk finding 1 of the sixth memory-provenance-gate implementation review.

## 1. Outcome

A click on any approval or question card is never lost between the platform and the ledger. Either the click is durably handled and the card is then terminalized, or the click could not be recorded and the card keeps its buttons so the owner can simply click again. The previous order (edit the card, then fire an un-awaited dispatch) left a window in which a host crash or database failure stranded a `pending` row behind a button-less card, with no sweep to revive it.

## 2. Scope

In: `ChannelSetup.onAction` becomes awaitable; the host's dispatcher returns whether a handler claimed the click and propagates a throwing handler; the chat-sdk bridge (Slack) records first and edits second; the Discord gateway path acknowledges with a deferred update (type 6, inside Discord's 3 s window, card untouched), records, then PATCHes the original message.

Out: any change to the approvals response handler, reason capture, OneCLI cards, or pending-question semantics. No schema change.

## 3. Design

- `dispatchResponse` (src/index.ts) returns `true` when a handler claimed the response and `false` when none did; a handler that throws is no longer swallowed, because a swallowed throw is exactly the "not recorded" case the bridge must see.
- The bridge awaits `onAction`; on rejection it logs and returns without editing (chat-sdk) or without PATCHing (Discord). `false` (stale card) still terminalizes, since nothing can be lost.
- A handler that owns the question but REJECTS the click (unauthorized clicker) returns `'refused'`: the bridge leaves the card actionable, because the row is still pending and the right person must still be able to act.
- A second click while the first is still being handled: the approvals handler transitions `pending → approved` exactly once and returns silently otherwise. The pending-question handler (interactive module, pre-existing) writes the answer to the agent's inbox and only then deletes its row, so two clicks that both pass the read can each append an answer; that duplicate is an accepted risk of this build, recorded in `run.md`, not a lost click.

## 4. Acceptance criteria (materialized in `src/channels/chat-sdk-bridge-click-durability.test.ts`, `src/modules/handoff-ledger/ledger.test.ts`, `src/cli/resources/handoffs.test.ts`)

- chat-sdk: a throwing recorder → no `editMessage`; a slow recorder → edit strictly after it resolves; `false` and legacy `void` recorders → edit.
- Discord: throwing recorder → exactly one fetch, the type-6 deferred acknowledgement, no PATCH; resolving recorder → deferred ack, then one PATCH to `/webhooks/<app>/<token>/messages/@original` with `components: []`.

## 5. Bundled operator fixes (Brian's "two small things")

- `ncl handoffs abandon --id --reason`: host-only (`hostOnly: true`, denied to every container caller by the CLI guard); closes a handoff from any non-closed state; records the reason as closure evidence and as an `abandoned` event by actor `host`; immutable fields and fingerprint untouched. Tests: ledger (created and delivered rows close; closed, empty reason and unknown id refused) and CLI (agent denied, host succeeds).
- Stale `Status: PROPOSED … not approved` headers on the two shipped plans replaced with the shipped record.

## 6. Rollout and rollback

Host restart after `pnpm build` and the upgrade-marker stamp. Rollback is `git revert` of the single commit plus the same stamp-and-restart. Residual: a Slack card keeps its buttons for as long as the approval handler runs (usually well under a second; a few seconds for a re-hold), which is the intended trade.
