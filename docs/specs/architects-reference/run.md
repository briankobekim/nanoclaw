# Architects reference import

User authorized sharing selected Architects Golf Club project material with Atlas and Echo. Completed 2026-09-14T15:47:38.658Z. Routine read-only knowledge import: main reviewed exact content, provenance, exposure and registry append; no new trust/permission boundary, code, migration or independent model review required. Team-plan/team-build and wwbd informed reuse of the existing shared reference folder. No site workflow was invoked.

## Published scope

- `projects/registry.md`: append-only reference entry; before SHA-256 `0e4ed6cc06324f72f53ce02cac6d7de77351f9001d29b0dc984f067182305cf5`, after `3ae7c242a7cf169118e0ad61ee6ac721765d1c2cb815972ab332dcbe3a174ac2`.
- `projects/architects-golf-club/brief.md`: SHA-256 `f8b5eb09c9b2b94223573c697a49c12aa4ec399336315ee4abe33e29e3fb80d6`.
- `sources/`: exact selected ChatGPT handoff plus presentation-guide.md, research-and-qa.md, phase2-qa.md; provenance.json records original paths and exact source hashes. Historical claims/instructions are clearly data, not fresh verification or authority.
- Only two configured agent groups have the existing projects mount: Atlas and Echo, read-only; all four running agent containers map to those groups. No Arch code mount, unrelated chats, credentials, deployment settings or images imported.

## Actual verification

Real containers `ncl-44a1d5b3-sess-1789390403180-eyiv9k` (Atlas) and `ncl-44a1d5b3-sess-1789390402324-exnlxe` (Echo): `sha256sum /workspace/extra/projects/registry.md /workspace/extra/projects/architects-golf-club/brief.md /workspace/extra/projects/architects-golf-club/sources/*` returned the exact published hashes for every file. `test ! -w .../brief.md` passed for both; Docker mount metadata independently reported `RW:false`. Both read checks exited 0. No conversational/model recall test was run or claimed.

Source checkout `/Users/kobekim/Documents/ChatGPT/Arch` remained clean at commit `e755b7bf9d56fd8ba1c735e52880af83c1219f9b`. Both personal-first prompts and materialized container settings retained their pre-import hashes. No memories/histories, auth, models, mounts, channel routing, default project or project pause changed. No restart, Slack message, site edit, build, deploy or automatic sync.

Publication used atomic exclusive directory lock, inside-lock `.stop` checks, exact old-registry hash checks, full directory publication followed by atomic registry replacement. Lock removed afterward. Original registry backup: `/private/tmp/architects-reference.0WM2Au/registry.before.md`; staged source and activation receipt remain there. One source-newline fidelity correction before publication; no failed live writes.

Suggested request: “Read the Architects Golf Club brief and tell me where we left off.” If needed, name `/workspace/extra/projects/architects-golf-club/brief.md` explicitly. The existing project registry is the discovery index; this does not make the snapshot automatically loaded or continuously current.
