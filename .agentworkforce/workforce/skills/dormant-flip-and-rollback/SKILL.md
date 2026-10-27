---
name: dormant-flip-and-rollback
description: Use when designing or executing a cutover-class change (migration, ingestion path swap, provider relink, flag enablement). Encodes the dark-launch + single-switch flip pattern, the refusal to flip on amber, and the pre-authorized rollback procedure — the canonical way to make irreversible-feeling infra changes reversible-feeling.
---

# Dormant flip and rollback

The safest cutover is one that looks routine after the fact because the actual switch was a single config write, and the rollback was the inverse of that write. This skill encodes the pattern.

## When to invoke

- Designing a multi-PR change that ends in flipping production behavior (queue swap, ingestion path migration, provider client cutover, feature general-availability).
- Reviewing a PR that proposes to enable a new code path "as part of the feature" — likely needs to be split into dormant-build + separate-flip.
- Authoring the flip command and rollback triggers for the autonomous-run contract.
- Executing the flip itself, post-gates-all-green.
- Observing a post-flip signal that matches a rollback trigger.

## The three properties of a safe cutover

### 1. Dormant by default

Every PR that contributes to the new path leaves that path **unreachable in production by default**. The new code exists, is type-checked, is unit-tested, is even integration-tested against a non-prod fixture — but no live caller takes the new branch.

Mechanisms (pick what fits the repo):

- **Feature flag default-disabled.** A boolean read from KV / SST / env / config, default `false`. The new code path is gated on `if (flag) { new() } else { old() }`. The old path keeps running.
- **Per-item enable list.** A KV map of `{ providerId: "new" | "old" }`. The default for any item not in the map is `"old"`. Enabling means adding a single provider with `"new"`; rollback means removing the entry (which falls back to default).
- **Side-by-side route.** The new route lives at `/v2/foo`; the old at `/foo`. Until a caller (CDN router, client SDK, internal config) is updated to call `/v2/foo`, no production traffic hits it. Cutover = updating the caller.

What does NOT count as dormant:

- "It's only a small change." Composition-time interactions ignore intent.
- "We default to off in the constructor." If any caller passes `true`, it's not dormant.
- "The new code is faster so we just turned it on." That's not a dark launch; that's a feature ship masquerading as one.

### 2. Single switch

The cutover is **one command**, not a sequence of three operations that each must succeed. The command is written into the contract verbatim (see `autonomous-run-contract` §5).

Examples:

- `wrangler kv:key put --binding=ROUTER_CONFIG nango_ingestion_path queue --remote`
- `pnpm sst secret set FeatureFlagX true --stage production`
- Merging a pre-prepared one-line PR that flips a constant in committed config.

If the switch requires two commands (e.g. enable per-provider for the canary set first, then a separate command for global), each is its own gated flip in the contract, with its own scoreboard entry, its own go/no-go decision, and its own rollback.

### 3. Refusal to flip on amber

A gate that is "probably green" is not green. The §4 pre-flip gate scoreboard is RED / GREEN, no AMBER promotion. If a gate is AMBER (passes some checks but not all; passes intermittently; passes in isolation but not under load), the flip is refused. Options:

- Add a concrete acceptance criterion that resolves the AMBER (the test that would prove it GREEN; the load that would prove it GREEN); run it; either RED or GREEN comes out.
- Split the change so the AMBER scope can be deferred to a follow-up flip.
- Escalate to operator to explicitly accept the AMBER as known risk before flipping.

Never flip "and watch closely" because a gate was almost green. The rollback triggers cost something to invoke (user-visible disruption, dual-write cleanup, on-call attention); a high probability of needing them is a reason not to flip.

## The flip procedure

When all gates read GREEN with evidence current within the last hour:

1. **Re-verify each gate one final time.** Evidence current. CI live for any code-path-dependent gate.
2. **Re-read the contract §5 + §6.** Confirm the flip command and rollback triggers.
3. **Post the pre-flip statement** to the operator's channel:
   ```
   Pre-flip statement, <run-name>, <ISO-utc>
   Gates: G1 GREEN <link>, G2 GREEN <link>, ... (full list)
   Flip command: <verbatim>
   Rollback triggers: <list, with thresholds>
   Rollback command: <verbatim>
   Proceeding in 60s unless told otherwise.
   ```
4. **Execute the flip command exactly as written in the contract.** No improvisation.
5. **Immediately start monitoring** the rollback triggers from §6. Sub-minute granularity for the first 10 minutes; 5-minute granularity for the next hour; check-in at 1h, 6h, 24h.
6. **Post the flipped statement** with the timestamp, the command output, the first batch of post-flip metrics.

## Rollback authority

Rollback is **pre-authorized by the contract**. When any trigger from §6 fires, execute the rollback command without consulting the operator. Then post:

```
Rollback executed, <run-name>, <ISO-utc>
Trigger: <name, e.g. G5 5xx rate>
Observed: <metric value, baseline, threshold>
Rollback command: <verbatim>
Output: <command output>
Post-rollback metrics in 5m: ...
Recommended next action: <pause / investigate / re-attempt with gate X re-validated>
```

The rule: rollback first, diagnose second. "Wait and see if it recovers" is the failure mode that turned 5-minute incidents into 50-minute incidents.

## After rollback

- Do not re-flip without re-running the full gate scoreboard.
- File a post-mortem note (the autonomous-run-contract location) with: trigger that fired, observed values, what the gate scoreboard said pre-flip, what the gap was that the scoreboard missed.
- Add a new gate to the contract that would have caught this gap (and run it RED to prove non-vacuity).

## Anti-patterns

- **Enabling-on-merge.** A feature PR whose merge starts driving real production traffic to the new path. The cutover should be a separate, intentional, contract-gated event.
- **Coupled flip + ship.** The same PR that ships the new code path also flips the flag. There's no way to roll back without reverting the code.
- **Soft rollback ("we'll just disable it manually if it's bad").** If rollback isn't pre-authored and pre-authorized, in practice you will hesitate, and the metric will be 10× worse by the time you act.
- **Flip while a gate is AMBER.** The single biggest cause of cutover incidents in delegated-autonomous runs.
- **Implicit rollback ("revert the PR").** A code revert is slower than a config flip and requires another deploy. The contracted rollback should be the inverse of the §5 flip — a config write, sub-minute.

## What this skill does NOT cover

- The contract that authorizes the flip and rollback (covered by `autonomous-run-contract`).
- The per-PR review bar that ensures dormant-safety lands correctly (covered by `auto-merge-and-composition-safety`).
- Diagnosing post-flip behavior to decide between rollback and continue (covered partially by `instrument-dont-guess`; ultimately the rollback triggers in §6 are intentionally mechanical to remove the diagnose-first temptation).
