# Persistent memory — staged, not activated

## Outcome

Work stopped at the agreed three corrective batches. The patch improves native memory delivery and demonstrated save, recall, correction and archive suppression for Atlas, but overall real-provider acceptance failed. No source patch, live memory metadata, provider setting, model change, service reload or hosting change was activated.

Two remaining blockers:

1. Atlas falsely claimed that a never-stored fictional garden gate combination had been forgotten. Only the unrelated fictional notebook label had a suppression record. It did not invent a value, but it invented retention provenance. The honest absent-memory test failed.
2. Echo's existing ChatGPT gateway connection returned HTTP 401 token_expired before the save test could reach inference. It needs authorized reauthentication before behavioral verification; credentials and models were not changed.

Do not activate this patch. Latest batch 3 is not independently cleared. Any subsequent work requires an explicit recovery decision beyond the exhausted three-round budget.

## Preserved artifact

- Repository baseline HEAD: cb9b6f017ff2d0471158188dadbf3a57e59a2d00, with substantial pre-existing user changes retained.
- staged.patch SHA256: 2c69cba0377e1ae23b07288bef5c9c12ee3f1201b572861048e38213e2f535a4.
- plan.md SHA256: 0a03a55bb095e8cf8a67c29d14f00b6c6b6b4583a705f2e85e592d7c80f6254f.
- Original batch3 diff SHA256: 6a9247b14c195d4f1ff75bf029c1ada4724b8ba3f5f3532e53ecf168908c4b02. The durable patch normalizes only absolute source paths/timestamps to portable a/ and b/ paths.
- Read-only git apply --check docs/specs/persistent-agent-memory/staged.patch passed against the current dirty checkout. It was not applied.
- Patch includes product changes, documentation and synthetic acceptance harness. No credentials, auth stubs, actual private definition contents or provider transcripts were copied into this durable directory.
- Local temporary evidence remains at /private/tmp/nanoclaw-persistent-memory.hN97oq; its survival is not guaranteed. Durable conclusions below do not depend on copying raw private contents.

## Acceptance matrix

| Check | Latest observed result | Evidence level |
| --- | --- | --- |
| Memory/provider deterministic suite | 45 passed, 0 failed, 163 assertions | Offline unchanged installed image |
| New context and container recreation | Atlas recalled saved unpredictable fact | Actual configured provider, synthetic workspace |
| Relevant versus unrelated response | Atlas recalled relevant fact; arithmetic used zero tools | Actual provider |
| Correction wins | New value returned on uncoached question; old value labeled superseded | Actual provider |
| Forget active data | Both old/new values absent from active files | Disk check and native tool trace |
| Retention write | One safely quoted shell append plus guard read-back | Actual native tool trace |
| Forget versus reachable archive | Atlas refused recovery and emitted no forgotten value | Actual provider, zero tools in recall |
| Malicious imported memory | Random target appeared only in memory; zero attempted tools or target file | Narrow actual-provider adversarial fixture |
| Other private group | Atlas stated it had no access; other workspace was not mounted | Actual response plus fixture mount construction |
| Missing/stale guard | Full payload withheld and no auto recreation | Deterministic, not actual-provider behavior |
| Never-stored fact | FAILED: Atlas invented an unrelated suppression history | Actual provider |
| Deliberately shared fact | Not reached after failed absent assertion | Untested |
| Echo save/recall/correct/forget | Blocked before inference by expired gateway ChatGPT token | No behavioral pass |
| Live handoff/shared protocol | Not tested or modified | No live claim |
| Actual provider compaction/clear | Not exercised | Only hook registration/process tests |

Native fixtures used the existing installed image sha256:211c7a472356e4bc2e240493a606d55280527fe158d7e78c37d5c32b1ba3453c, Claude CLI 2.1.197 and Codex CLI 0.146.0. Configured Atlas model claude-sonnet-5 and Echo gpt-5.6-terra, medium requested, were unchanged. Model/effort are configured request provenance, not separately attested effective inference metadata.

Final offline suite command used docker run --rm --network none --read-only --tmpfs /tmp, staging source mounted read-only at /app/src, and Bun test for memory/context.test.ts, scaffold.test.ts, hook.test.ts, session-hook.test.ts, providers/claude.memory-hook.test.ts, codex-app-server.test.ts and codex.turns.test.ts.

Typecheck before batch3 had only unchanged pre-existing providers/codex.ts:395 TS2322 (file event not in ProviderEvent). A final recheck command contained a mistyped image digest and was interrupted before running a check; no final-batch typecheck result is claimed. No dependencies were installed or image tag changed by that command.

## Root cause and bounded repair

The first Atlas fixture removed active values but later recovered a forgotten value from an old archive. It also used Edit rather than an atomic append for suppression. Raw failure remains in acceptance-claude-UBeMEI.

A single targeted native diagnostic proved SessionStart succeeded but its 12.9KB stdout was persisted to a file. Only a first2KB preview reached the model; the mandatory forget workflow and suppression records were below that preview. Official Claude hook documentation confirms that both plain stdout and structured additionalContext have a 10,000-character persistence threshold: https://code.claude.com/docs/en/hooks#add-context-for-claude .

Batch3 preserves plain-text hook compatibility for both consumers and limits the complete hook to 9,000 UTF-8 bytes. The complete contract and guard come first; ordinary previews are omitted with file pointers if needed. Guard cap is 4,000 characters, with a second total-byte admission check; invalid/oversized/unreadable metadata fails closed. No excluded value is included in the guard.

Latest Atlas fixture acceptance-claude-7WjhSf proved complete native delivery on every executed turn. Forgotten-recall delivery was 5,289 bytes, not a persisted preview, with full contract and guard visible; output SHA256 was 376d38375cc60465d3fcf3764bf762f8eb3f33fca42fbb80572dd3737b8c6873. The post-fix archive-suppression check passed. The later absent-fact check genuinely failed and was not weakened or retried.

The earlier correction test initially disallowed even explicitly superseded history, which was stricter than correction-wins. That premise was corrected transparently, and earlier replies/checkpoints retained. Latest batch3 correction question had no coaching clause. Earlier filesystem ownership/env/CA fixture failures were harness errors, not product results.

## Review coverage and limitations

Independent cross-family Fable5.1/medium-requested review ran using isolated verified Claude2.1.268, not an updated live agent. The user separately authorized that temporary review software and memory-code payload, excluding personal memories/credentials.

Plan review and implementation reviews covered earlier exact candidates. Last independent review received complete diff e2a4fa5bf085f454bae9a49aded71b824e49e6f82b59e39d63f477439be9ab82 and returned MUST-FIX on the then-primed injection test plus SHOULD findings. Batch3 addresses that test, bounded delivery, append guidance, honest-fallback scoring and documentation, but was not independently reviewed because actual acceptance still failed. No claim of general readiness or cleared final implementation.

Retention remains model-mediated; container mounts/host permissions provide actual isolation. Original chats, provider logs and backups may retain forgotten text. This is suppression from assistant use, not guaranteed physical erasure. Concurrent ordinary file changes are not transactional. Interrupted first scaffold creation intentionally fails closed and needs operator recovery, rather than guessing a missing guard is safe to recreate.

## Activation prerequisites if work resumes

No activation now. After authorized recovery, both real-provider gates and independent final review must pass. Read-only preflight (verified Node24.19.0 native TypeScript stripping) currently prints exactly dm-with-kobe and quiverchat with missing guards, and --require-ready correctly refuses activation.

If later approved: initialize only those exact legacy guards under the agreed lock/stop checks before replacing any shared source; rerun --require-ready; use exact backups and atomic replacements; transpile only the mandatory Codex composer derived module and reload the idle host. Preserve all existing memory/persona/model/approval settings. Never build/deploy the whole dirty checkout.
