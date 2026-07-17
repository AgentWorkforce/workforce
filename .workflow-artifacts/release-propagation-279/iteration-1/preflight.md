# Preflight: workforce #279

- Repository: `/Users/khaliqgant/Projects/AgentWorkforce/.worktrees/workforce-279`
- Base: `origin/main` at `533b966`
- Branch: `codex/issue-279-bundle-versions`
- Issue: `AgentWorkforce/workforce#279`
- Declared write scope: workforce source/tests/docs and this workflow artifact directory only.
- External writes allowed: commit, push, PR creation, PR comments, CI/review repair.
- External writes prohibited by contract: merge, npm publish/release, deployment, production mutation, rollback.
- Codex probe: `codex exec --ephemeral --json --sandbox read-only -m gpt-5.4` returned `OK`.
- Claude CLI: present at `/opt/homebrew/bin/claude`; supervisor is read-only unless explicitly assigned a finding fix.
- Agent Relay broker: healthy at kickoff.

## Acceptance focus

1. Record resolved versions for packages actually bundled into `agent.bundle.mjs`, especially `@relayfile/*`.
2. Keep the generated runtime dependency pin intact.
3. Surface the same manifest at runtime in structured `runner.started` evidence without secrets or nondeterministic paths.
4. Provide an operator-queryable artifact or supported JSON surface for determining deployed versions.
5. Prove recorded versions match the bundle inputs, including workspace/symlink and missing-package edge cases.
6. Do not publish or deploy during this granted phase.

## Cross-repository scope matrix

| repo | branch | issue | surface | expected change | status | owner |
| --- | --- | --- | --- | --- | --- | --- |
| workforce | codex/issue-279-bundle-versions | #279 | deploy bundle/build metadata/runtime observability | record and surface exact bundled versions | implementing | Workforce279CodexImpl |
| relayfile-adapters | pending | #248 | relay helpers create receipt semantics | dependency-only for this iteration | deferred until G2 | future squad |
| cloud | pending | #2678 | update-time watch glob derivation/backfill | intentionally deferred until G2/G3 | deferred | future squad |

## Reviewer verdict contract

Reviewers must use `VERDICT: COMPREHENSIVELY_SATISFIED | FINDINGS | BLOCKED` and include deterministic evidence, end-to-end wiring assessment, scope-matrix status, and remaining risks. Findings require stable ids, severity, file, exact fix, and required test.
