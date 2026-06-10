---
name: swarm-blockers-and-gate-scoreboard
description: Use during an autonomous run to (a) dispatch supporting codex-impl + claude-review agent pairs against hard blockers when the orchestrator cannot make progress alone, and (b) maintain the live RED / GREEN gate scoreboard the orchestrator reads to authorize the flip. Encodes the file-based reporting convention that keeps the channel readable.
---

# Swarm blockers and gate scoreboard

Two related disciplines for autonomous runs:

- **Swarm blockers**: when the orchestrator encounters a hard blocker that requires more concurrent work than it can carry, dispatch supporting agent pairs (codex implementer + claude reviewer) to resolve the blocker from repo ground truth. Structural proof beats runtime verification where applicable.
- **Gate scoreboard**: maintain a live RED / GREEN board of every pre-flip gate from the contract, with evidence links and timestamps. The orchestrator reads this board to authorize the flip; the operator reads it to grant or deny the flip-authority moment.

Both presuppose a contract (see `autonomous-run-contract`) and the file-based reporting convention.

## Swarming a blocker

### When to swarm

- A blocker that requires reading + reasoning across enough of the repo that one agent will thrash (e.g. cross-PR composition audit, schema-vs-adapter parity audit across 40+ resources).
- A blocker that requires concurrent code-and-review iterations (impl writes, reviewer pushes back, impl iterates) faster than a single agent can carry both roles.
- A blocker the orchestrator has identified the shape of but cannot itself fix without losing focus on the run-level orchestration.

When NOT to swarm:

- A blocker the orchestrator can resolve in one focused 10-minute slot.
- A blocker that's actually an escalation (external dependency, product decision) — those go to the operator, not to spawned agents.
- A blocker for which the swarm budget granted in the contract (§2 `swarm-blockers authority`) has been exhausted.

### Pairing rule (this is a standing constraint, not a preference)

Every spawned workstream is a **codex-impl + claude-review pair**. Never:

- A codex lead with codex impl agents (they fight over ownership; the lead-codex injects its own implementations into the impl-codex's channel, breaking the review loop).
- A solo agent for non-trivial work (no fresh-eyes review = same blindspot loops).
- A claude impl + codex review pair (the agent-role split in the cloud-repo workforce has codex implementing, claude reviewing — reversing it breaks the convention spawned agents are tuned for).

The orchestrator role is yours — the orchestrator is a claude agent itself, but it does not implement; it dispatches and aggregates.

### Dispatch contract per workstream

Every spawned pair gets a written sub-contract:

```
WS-<name> sub-contract
  Parent run: <run-name>
  Goal: <one sentence — what RED becomes GREEN when this workstream finishes>
  Inputs: <PR/file/issue references>
  Acceptance: <specific, measurable, file-based — "the verify gate in /tmp/ws-<name>-acceptance.sh returns 0">
  Out-of-scope: <what NOT to touch — keep the blast radius tight>
  Pairing: codex impl <agent-id>, claude review <agent-id>
  Status file: /tmp/ws-<name>-status.md
  Budget: max <N> review-fix cycles, max <hh:mm> wall time
  Escalation: if blocked, the workstream writes BLOCKED to its status file with the blocker; do not pause silently
```

Surface the sub-contract to the operator if the swarm-budget grant in the main contract is being approached.

### Structural proof > runtime verification

For correctness-class blockers (does this code-graph property hold? does this invariant compose across PRs? does every provider have an adapter entry?), prefer a **structural proof** to a runtime test:

- A failing typecheck against a generated source-of-truth registry.
- A `git grep` count assertion against a known-complete list.
- A bundler import-graph assertion (the cloud-repo `tests/b1-worker-import-safety.test.ts` is exemplary — it's not a runtime test; it's a static assertion over the bundled output).
- A compile-time exhaustiveness check (TypeScript discriminated-union switch with `never` default).

Runtime verification has its place (`instrument-dont-guess` is built on it), but for invariants — "every provider declares a model in REPO_DECLARED_NANGO_PROVIDER_MODELS" — structural proof catches drift the moment it's committed, not the moment it ships to prod.

The pattern in dispatch: include the structural-proof assertion as the acceptance verify gate.

### Aggregation

The orchestrator reads `/tmp/ws-*-status.md` for each active workstream. It does NOT poll the channel for status — agents truncate. Channel messages from workstreams carry only:

- `WS-<name> GREEN, see /tmp/ws-<name>-status.md` (success)
- `WS-<name> BLOCKED, see /tmp/ws-<name>-status.md` (need orchestrator attention)
- `WS-<name> ESCALATE, see /tmp/ws-<name>-status.md` (need operator attention)

The orchestrator aggregates into `/tmp/<run-name>-rollup.md` and updates the gate scoreboard.

## The gate scoreboard

The scoreboard is a single markdown file (`/tmp/<run-name>-scoreboard.md`) maintained for the run's lifetime. It contains one row per pre-flip gate from the contract §4, with:

```
| # | Gate | State | Evidence | Last verified | Owner |
|---|---|---|---|---|---|
| G1 | Worker bundle B1 safety | GREEN | b1-worker-import-safety.test.ts pass @ <sha> | <ts> | orchestrator |
| G2 | Hyperdrive client on Worker | GREEN | /tmp/ws-hyperdrive-status.md, PR #743 merged | <ts> | WS-hyperdrive |
| G3 | Queue consumer idempotent under dup | RED | dedup test red; no Postgres backing yet | <ts> | WS-dedup |
| G4 | Rollback path proven | AMBER | rollback command tested in staging, not prod | <ts> | orchestrator |
| ... |
```

States: **RED** / **AMBER** / **GREEN**. The contract §4 says AMBER is not flippable; the scoreboard makes AMBERs visible until they resolve.

### Scoreboard hygiene

- **Update on every state change.** A workstream flipping a gate GREEN updates the row + bumps `Last verified`. A gate going stale (no verification in >2h on a fast-moving run) drops back to AMBER.
- **Evidence is a pointer.** Link the PR, the CI run, the status file, the structural-proof output. The row should not contain the evidence in-line.
- **The orchestrator re-verifies before the flip.** Final pre-flip pass: re-run each GREEN gate's acceptance check, refresh the `Last verified` to within the last hour, confirm every row reads GREEN.
- **One scoreboard per run.** Not per workstream. The scoreboard is the union of evidence the operator needs to grant the flip moment.

### Gates as the orchestrator's working set

The orchestrator does not run "all the work" — it owns the scoreboard. Every action it takes is in service of moving a RED gate to GREEN, or re-verifying a GREEN that's gone stale. If an action doesn't map to a gate, ask whether the gate is missing from the scoreboard or whether the action is out-of-scope for the run.

## File-based reporting convention (repeated here because it's load-bearing)

- Each workstream writes to `/tmp/ws-<name>-status.md`.
- The orchestrator aggregates to `/tmp/<run-name>-rollup.md`.
- The gate scoreboard is `/tmp/<run-name>-scoreboard.md`.
- The contract is `/tmp/<run-name>-contract.md` (or wherever it's pinned per `autonomous-run-contract`).
- Surface to the operator only on action points (gate goes RED, escalation, flip-authorization moment, post-flip metrics, rollback).

The channel carries one-line pointers + state changes; nothing substantive lives only in channel messages. This convention exists because agent-to-agent channels truncate, and because the operator needs to be able to read back the run state on returning to the channel after hours away.

## Anti-patterns

- **Spawning without a sub-contract.** Workstream drifts, blast radius unclear, orchestrator can't tell when it's done.
- **Codex lead with codex impl agents on one channel.** Ownership fights. Use claude orchestrator → codex impl + claude review pairs.
- **Polling channel for status.** Truncation eats the answer. Read status files.
- **Scoreboard going stale.** GREENs from yesterday are not GREENs today. Re-verify before the flip.
- **AMBER flips.** Either resolve to RED or GREEN. AMBER is a request for more evidence, not a flippable state.
- **Action that doesn't map to a gate.** Either it's out-of-scope (decline) or the scoreboard is missing a gate (add).

## What this skill does NOT cover

- Authoring the contract that grants swarm authority and lists the gates (covered by `autonomous-run-contract`).
- The per-PR auto-merge bar each workstream's PR must hit (covered by `auto-merge-and-composition-safety`).
- The diagnostic-first protocol when a workstream's fixes keep failing (covered by `instrument-dont-guess`).
- Decomposing a high-volume change into tier-1 + tier-2 (covered by `tiered-acceptance`).
