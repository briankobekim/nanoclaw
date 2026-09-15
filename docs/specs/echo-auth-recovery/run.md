# Echo availability incident — 2026-09-14

## Final result — 2026-09-14 14:58 UTC

Echo availability is restored. Dedicated device sign-in completed after the user enabled device authorization. The new login matched the existing gateway account; at14:51:49Z only the existing credential value was replaced through the supported API. Secret metadata, host scope and assignments remained exact. Protected credential backup: /Users/kobekim/.onecli/backups/echo-dedicated-auth-20260914-LPT1mP. No stale credential rollback is safe after this replacement.

Fresh Echo answered “Echo is back online.” at14:52:49.185Z; Slack delivered message1789397570.122459 at10:52:50.139 Eastern. Fresh runtime had no read-only filesystem, token_expired, invalid_refresh_token or401Unauthorized errors. See acceptance.json for sanitized exact evidence.

Atlas's unchanged Sonnet5/medium provider route completed one tools-disabled, memory-free disposable call with exit0/is_error=false. The exact sentinel response assertion did not match; this proves provider-call availability only, not a new Atlas live conversation or semantic acceptance test. No Atlas runtime/model/project mutation.

Final gateway tripwire passed14:57:36Z with exact pinned image and healthy state. Its prior bounded capture hit ENOBUFS on more than8MiB of historical logs; a streaming scan now preserves only128characters per stream and has a30second timeout. This is incident repair batch3: batch1 gateway refresh fix/migration, batch2 same-account dedicated credential recovery, batch3 permanent-check large-log robustness. Initial fixture placeholder strictness and expired device challenges are recorded as test/input obstructions, not new product architecture.

At14:58:29Z the exact two isolated rehearsal containers/volumes and their internal network were removed; the dedicated temporary login directory was removed; this incident lock was released. Protected backups retained. Deleted rehearsal copies can be reconstructed from those protected backups. Temporary live auth.json had already been removed immediately after successful vault replacement.

Remaining limitation: the new credential has not naturally expired during this check, so future refresh success is not claimed as directly observed. The official pinned client-id fix, source ancestry/binary proof and permanent deterministic deployment check cover the diagnosed request defect. The old refresh token was independently invalid, requiring user sign-in. No memory upgrade, agent image/model change, broad rebuild or prior failed-work replay was performed. Incident accepted; subsequent unrelated memory work remains staged/unaccepted.

User requested Fix Echo after Slack showed Reconnecting / Read-only file system (os error30), then explicitly approved shared OneCLI1.43.1 update and access-policy migration with backup and isolated rehearsal first. Separate from the staged, unactivated persistent-memory upgrade. Retained owner, maximum three incident repair batches; first live gateway repair applied. No agent model, memory, project, PostgreSQL version or read-only credential-mount changes.

## Root cause and approved fix

At12:53:24Z gateway1.41.0 automatic OpenAI refresh returned400 Missing client_id / missing_required_parameter, followed by expired-token401. Echo then tried to update its intentionally read-only placeholder auth file. The mount was not the root cause and remains read-only. Six already-acknowledged failed user messages were not replayed.

Public upstream [f8179ac80e003dacd16a0e4dfee2f0db330211bb](https://github.com/onecli/onecli/commit/f8179ac) adds the public Codex OAuth client identifier to the refresh form and regression tests. GitHub comparison proves it is an ancestor of exact target revisionc1e0e82d8393bf50a5cda4b14eb3033931d43bca; the pinned target binary contains the same public identifier.

- Old actual ARM64 image: ghcr.io/onecli/onecli@sha256:66dc84042310cab762ed3b1f71a98349a72aa132ad44651b7ae76c371aaafe6b (1.41.0). Earlier bfb197 digest was compose/index metadata, not the actual running-image rollback target.
- New actual image: ghcr.io/onecli/onecli@sha256:392c2a9c358f01607c9bc841c7458c83f23f8343b6949b3260ca5b35a7131b5a (official1.43.1, revisionc1e0e82d8393bf50a5cda4b14eb3033931d43bca).
- PostgreSQL unchanged: sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2.

## Rehearsal, review and live checkpoint

Protected initial backup: /Users/kobekim/.onecli/backups/echo-auth-20260914-o21f5n. Clone used separate volumes, internal-only network, no published ports and no default route: cloned credentials could not refresh externally. Restore succeeded; all15 pending migrations applied; one legacy project converted, zero failed. All original columns in ten auth/policy tables matched exactly. Four agent SDK configurations retained env, CA and placeholder contents; only generated last_refresh timestamps differed.

Actual baseline had zero custom policy rules and default allow. Migrated state has one enabled published default allow rule, no identity/target filters, rate limits or approval modifiers, plus its draft twin. Existing secret host matching and assignments remain unchanged. Actual drop/recreate/restore over the migrated clone succeeded, with all ten tables restored exactly.

Independent Fable5.1 operational review completed. Must-fix ancestry proof and post-token-rotation rollback branch were accepted and resolved before coordinator cleared activation. This was an operational review, not a whole-vendor-release audit.

Final idle checkpoint used an atomic incident lock and inside-lock stop fence. Gateway stopped; zero other database clients remained; auth/policy baseline still matched rehearsal. Fresh final backup: /Users/kobekim/.onecli/backups/echo-auth-final-20260914-BHX0Fn. Only the compose gateway image line changed, atomically; only gateway was recreated. No host rebuild or PostgreSQL restart.

At13:22:29Z live new gateway was healthy, ten original-column tables exact, published policy correct, and Codex credential ciphertext unchanged from quiesced checkpoint. Encryption key and CA/key exact bytes matched backup. Whole tar hashes differ because of archive metadata; key/CA byte comparison is the relevant check. Manual scripts/check-echo-gateway.mjs passes pinned-image, health and missing-client-id regression checks. It is not an authentication acceptance test or scheduled monitor.

## Historical live acceptance and sign-in blocker

One scoped Echo-only restart, no rebuild, requested a recovery reply through the normal on-wake path. Fresh gateway requests now receive OpenAI401 invalid_refresh_token, not the old400 missing_client_id. Echo has NOT recovered its ability to answer. This proves a second, independent need for dedicated human reauthentication. No repeated login or token-refresh workaround was attempted. Gateway remains healthy on the fixed release; no rollback to the known old bug.

Official device login started with host Codex0.151.0 under a new owner-only temporary credential directory, no personal auth cache, no gateway proxy. User receives the official short-lived challenge directly; challenge and token values are not retained in this report. At13:28Z sign-in remained pending, attached process17282. Prepared supported PATCH /v1/secrets/<existing-id> replacement checks account identity against current metadata, backs up the existing encrypted record, updates only its value, and checks metadata/hostscope/assignments afterward. Not executed while login is pending. Account mismatch requires user choice.

Existing record: c7d4ba5d-5ca1-4e8f-bf3e-445b02dba09b, openai/chatgpt.com. Setup helper skips an existing secret and its login helper creates a duplicate, so neither is run blindly. Never copy personal ~/.codex/auth.json. [Official device authentication documentation](https://learn.chatgpt.com/docs/auth).

After successful dedicated sign-in: replace only the same-account existing record, verify a fresh real Echo reply and absence of readonly-auth errors, verify Atlas basic availability, then close incident lock and remove isolated cloned credential volumes. No claim of completed live acceptance yet.

Rollback rule: before provider activity, restore only the final quiesced snapshot if no intervening accepted writes. After credential rotation or replacement, NEVER restore stale credential ciphertext; preserve new state and obtain a recovery decision on later failure. No automatic downgrade.

Raw nonsensitive operational evidence and launchers: /private/tmp/echo-auth-recovery.JNCKGK/{verification.json,rollback-verification.json,live-checkpoint.json,live-nonprovider-verification.json,gateway-review-raw.json}. Private backups are owner-only and were not sent to the reviewer. Persistent-memory staged patch remains unapplied.
