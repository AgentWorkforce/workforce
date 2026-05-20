---
name: autonomous-run-contract
description: Use at the start of every autonomous, multi-PR, cutover-class delegated run. Authors the binding contract between operator and agent — the gates, the flip mechanism, the rollback triggers, the standing constraints, and the explicit escalate-to-human conditions — and surfaces it to the operator for explicit grant of (a) auto-merge authority, (b) flip-the-switch authority, (c) swarm-blockers authority. No autonomous work begins until the contract is acknowledged.
---

# Autonomous Run Contract

A cutover-class delegated run (multi-PR, multi-day, irreversible-by-default infra change) does not begin with "start working." It begins with a **written contract** that the operator explicitly grants. The contract is the single document the autonomous agent re-reads at every decision point to determine whether it has authority for the next action.

This skill produces that contract. Without it, the agent will eventually either (a) over-step (merging or flipping without authority), or (b) freeze (refusing to act because authority is ambiguous). Both are session-killers.

## When to author a contract

- Any run the operator describes as autonomous, hands-off, "drive to done," cutover, migration, or with an explicit grant of merge/flip authority.
- Any run that will produce 3+ PRs across 1+ days.
- Any run with an irreversible step (a flag flip, a data migration, a DNS change, a destructive cleanup).
- Any run where the operator is granting authority to spawn supporting agents.

If none of those apply, this is regular work — skip the contract.

## Structure of the contract

The contract is a single markdown document (`/tmp/<run-name>-contract.md` or a PR comment / channel-pinned message) with these named sections, in this order:

### 1. Run identity

- One-line statement of the deliverable (e.g. "Cut Nango webhook ingestion from SQS to Cloudflare Queue, dark-launched, single-switch flip").
- Tracking PR / issue / channel.
- Start timestamp.

### 2. Grants requested (operator must explicitly grant each)

- **Auto-merge authority** — on which PRs, against which bar (see §3).
- **Flip authority** — for which feature flag / KV key / config write, with the exact command, when all pre-flip gates are GREEN.
- **Swarm-blockers authority** — authority to spawn N supporting agents to self-unblock when ground truth requires more concurrent work than one agent can carry; with budget (max-agents, max-cost, max-duration).
- **Rollback authority** — pre-authorized to execute the rollback procedure on any of the rollback triggers in §5.

Each grant is requested with a one-line ask. The operator either says "granted" (any of: explicit "go", thumbs-up, "approved") or scopes it down ("granted for PRs A,B; not C"). No grant = no autonomous action of that type.

### 3. Per-PR auto-merge bar

The minimum bar that must hold for the agent to merge a PR autonomously. Anything below this bar = manual operator review required.

- **CI status verified LIVE at merge time** — `gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup` against the head SHA at the moment of merge, not against a snapshot taken N minutes ago. `MERGEABLE` + `CLEAN`. Any state below `CLEAN` (`BLOCKED`, `BEHIND`, `UNSTABLE`, `DIRTY`) blocks the merge.
- **Substantive review by area applicable to the change**, not a wave-through. Cover at minimum: F0-class correctness (the headline behavioral change works); Worker-bundle safety (no Node-only imports added in Worker entry graph) where the change touches Worker code; dormant-safety (default-disabled, no caller turns on dormant new path); idempotency (queue/webhook handlers); rollback path preserved.
- **Bot reviewers audited, not waved.** Every CodeRabbit / Devin / Codex review comment gets read against the current PR head. Many are stale (the bot reviewed an earlier commit, the issue is fixed on HEAD); reply on the PR documenting the audit. Genuine blockers get addressed before merge.
- **Worktree for the PR work.** Never co-mingle PR changes with other branches' uncommitted state.
- **Never merge on red.** No `--admin` past red checks. If a check is broken because of an upstream issue (e.g. inherited-from-main failure), document the inheritance with a `git diff origin/main` and seek the operator's explicit waiver.

If any clause fails, the merge is not authorized by the contract — escalate.

### 4. Pre-flip gates (numbered, all GREEN, zero AMBER)

These are the binding gates between "code merged" and "switch flipped." Each gate has:

- A short name (e.g. `G3: Worker bundle B1 safety`).
- Acceptance criteria (specific, measurable — `tests/b1-worker-import-safety.test.ts` returns 0 errors; the synthetic regression for the failure class runs RED without the fix).
- An evidence pointer (CI run URL, log timestamp + structured-log query, file:line + revision, a `/tmp/<gate>-evidence.md` file).
- A status: RED / AMBER / GREEN. **AMBER is not flippable.** Either the gate is GREEN with evidence or it is RED.

The contract enumerates every gate up front. The agent maintains a live scoreboard during the run (see `swarm-blockers-and-gate-scoreboard`). The agent does not flip until every gate reads GREEN with current evidence.

### 5. Flip mechanism (the one switch)

The single command that changes prod behavior, written out exactly. Examples:

- `wrangler kv:key put --binding=ROUTER_CONFIG nango_ingestion_path queue --remote`
- `pnpm sst secret set FeatureFlagNangoQueue true --stage production`
- A pre-merged PR that flips a constant, ready to merge as a one-liner.

The flip is one command. If it requires three commands in a sequence (e.g. enable per-provider, then enable globally), enumerate each as a sub-step with its own gate.

### 6. Rollback triggers (immediate, no "wait and see")

Specific, measurable signals that revert immediately when seen post-flip, without consulting the operator:

- HTTP 5xx rate on the affected route ≥ X% over Y minutes (vs pre-flip baseline).
- DLQ depth growth ≥ X messages/minute sustained over Y minutes.
- A post-deploy-verify check (`tests/post-deploy-verify-*.sh`) regresses.
- A structured-log error class spikes ≥ Nx baseline.
- The synthetic regression test for the failure class starts failing.

Each trigger names the exact metric source, the threshold, the duration, and the rollback command (the inverse of the flip in §5). Rollback authority is pre-granted in §2 so the agent does not pause to ask.

### 7. Standing constraints (override everything)

These override any other instruction, even an explicit operator grant, unless the operator re-affirms with awareness of the constraint:

- **No manual prod deploy.** All prod changes flow through CI.
- **No direct prod SQL.** Schema changes via Drizzle migrations through PRs.
- **Redact secrets in logs / channels / PRs / reports.**
- **Pairing rule for spawned agents:** codex impl + claude review. Never a codex lead with codex impl agents on the same channel.
- **Instrument-don't-guess after two failed fixes.** Ship a diagnostic before more fix code.
- **Battle-tested ≠ works-once.** A fix is proven only under sustained + concurrent load + with the failure-class regression test running RED without it.
- **Repo-specific rules** the operator references (e.g. cloud repo's SST resource registration seven-place change; the journal-update-for-drizzle-migrations check; the integration-adapter-registry invariant). Enumerate the specific rule files (`.claude/rules/<name>.md`) the contract honors.

### 8. Escalate-to-human conditions

The agent stops and asks when:

- An external dependency is unresolvable (a third-party API is down, a cloud quota requires operator-only action, a billing limit is hit).
- A product or security decision is required (a scope question, a UX trade-off, a data-classification call).
- Two consecutive deploy failures without a credible root cause hypothesis.
- Any suspected data loss, even speculative.
- Any irreversible action beyond the §5 flip (a destructive cleanup, a DNS change, a paid-tier upgrade).
- The §3 auto-merge bar cannot be honestly met (e.g. the CI failure is a real regression, not stale, and the fix is non-obvious).
- The §4 gates are at AMBER and the operator has not pre-authorized AMBER promotion criteria.

For each, the agent posts the escalation as a single clear message: what is blocked, what was tried, what specific decision is needed, what the agent recommends. Then waits.

## Authoring flow

1. **Draft.** Write the contract from the operator's kickoff message. Fill every section. Where a value is unknown (e.g. the operator hasn't named the flip mechanism yet), name the gap explicitly with `[?: need operator input]`.
2. **Surface.** Post the full contract to the operator. Highlight the grants requested in §2 — each requires explicit acknowledgement.
3. **Iterate.** The operator will scope grants down, add/remove gates, refine triggers. Update the document until the operator says "granted" or equivalent on every grant.
4. **Pin.** Save the final contract somewhere the agent can re-read it at any decision point (a PR comment, a pinned channel message, `/tmp/<run-name>-contract.md`). Note its location in the agent's session state.
5. **Re-read.** Before every irreversible action (merge, flip, rollback, spawn), re-read the relevant contract sections. Never act on memory of the contract.

## What this skill does NOT cover

- The actual implementation of the gates (covered by `swarm-blockers-and-gate-scoreboard`).
- The per-PR review protocol (covered by `auto-merge-and-composition-safety`).
- The diagnostic-first protocol when stuck (covered by `instrument-dont-guess`).
- The dark-launch + flip design (covered by `dormant-flip-and-rollback`).
- Tiered acceptance for high-volume work (covered by `tiered-acceptance`).

This skill is upstream of all of them — they presuppose a signed contract exists.
