---
name: tiered-acceptance
description: Use when a single gate would require deep proof across a large set (44 models × 10 providers; 60+ resources; every region; every plan tier). Splits the acceptance into tier-1 (deep proof on high-volume / high-fidelity slice) and tier-2 (smoke proof on low-volume tail), documents the explicit accepted trade-off, and preserves safety through dormant-default + per-item enable + rollback.
---

# Tiered acceptance

When a single gate's acceptance criterion would require deep proof across a large set — every model × every provider, every resource × every adapter, every region — the gate becomes the long pole of the run. Either deliver less, ship without proof on the tail, or split. Splitting honestly is the option this skill encodes.

## When to invoke

- A gate whose ideal acceptance is "all N variants pass deeply" with N large (say ≥20).
- A long-pole gate that's blocking the rest of the scoreboard from going GREEN, with most of the work in the tail.
- A migration where the high-volume slice covers >90% of real traffic but the long-tail variants exist and have non-zero traffic.

If N is small (<10) or the variants are uniform (same adapter, parameterized), don't tier — prove all of them.

## The split

Divide the set into two tiers by **realized criticality** — not by alphabetical convenience, not by ease.

### Tier 1 — full proof

The slice where:

- Traffic / usage is concentrated (cover the top X% by volume — pick X to clear a defensible threshold, often 90%).
- Failure has highest blast radius (the integration the operator's customers actually use).
- Fidelity matters (provider parity is the explicit promise; long-tail divergence is less promised).

For tier-1, the acceptance is the full proof from the original gate intent: deep behavioral parity test, sustained-load test, the failure-class regression test running RED without the fix, cross-PR composition audit, the works.

### Tier 2 — smoke proof

The long tail. Acceptance is reduced to: "the path executes without error on a representative sample." Not the deep parity proof. Not the sustained load.

Smoke proof concretely means:

- A single instance per tier-2 variant runs the happy path end-to-end and succeeds.
- The variant's wiring exists (registry entry, adapter, schema) and matches the structural-proof invariants from `swarm-blockers-and-gate-scoreboard`.
- Failure of a tier-2 variant in production is recoverable by the rollback procedure or by per-item disable.

The tier-2 acceptance is honestly weaker. The trade-off is named.

## Safety preservation for tier-2

Tier-2 ships under reduced proof. The safety net comes from the dormant-flip + per-item-enable pattern (`dormant-flip-and-rollback`):

- **Dormant by default.** Tier-2 variants are not enabled on merge.
- **Per-item enable.** The flip mechanism enables variants one at a time (per provider, per model, per region). The operator chooses the rollout order: usually tier-1 first (deep-proof gives high confidence; observe in prod), tier-2 in batches (lower confidence; observe more carefully).
- **Per-item rollback.** A misbehaving tier-2 variant is disabled by removing one entry from the enable list. The rollback is variant-scoped, not run-scoped. The other variants stay enabled.

This is the trade-off mitigated: deep proof on the high-fidelity slice, smoke proof on the tail, but in production each variant is enabled and observable independently, and any single variant's failure is recoverable without disrupting the others.

## Documentation

The split is **declared in the contract** before tier-2 work begins:

- Contract §4 (pre-flip gates) lists the tiered gate as two entries: "Gate G7a — tier-1 full proof for {enumerated variants}" and "Gate G7b — tier-2 smoke proof for {enumerated variants}".
- Contract §6 (rollback triggers) names the per-item rollback command and the threshold per variant (often the same threshold as the run-level, just scoped to the variant's metrics).
- Contract §8 (escalate) lists the conditions that would force a tier-2 variant into tier-1 (e.g. "if the variant's traffic exceeds X% of total, promote to tier-1 and add deep proof before re-enabling").

Surface the split to the operator at contract-authoring time. Get explicit acknowledgement of the tier-2 reduced proof. Without that, the operator may have assumed full proof and the trade-off was never theirs to accept.

## Enumeration discipline

The variant list — both tiers — must be **enumerated from a generated source of truth**, never hand-maintained. The drift class is the same as the cloud-repo `REPO_DECLARED_NANGO_PROVIDER_MODELS` lesson: a hand-list that mirrors a generated list silently drifts, and a missing entry silently disables the variant.

- Generate the variant list from the registry / adapter directory / config.
- Assert at compile time (or in the structural proof) that the generated list and the tier-1 + tier-2 enumerations are exhaustive and disjoint.
- Drift in either direction (a variant in the registry that's in neither tier; a variant in a tier that's not in the registry) is a CI failure.

## Promotion criteria

A tier-2 variant may need to be promoted to tier-1 mid-run or post-flip:

- Its observed traffic share grows past a threshold the contract names.
- A real incident on the variant exposes a failure class smoke proof would not catch.
- The operator's product priorities change.

Promotion is not a silent step. It re-opens the gate scoreboard: the promoted variant gets deep proof, the gate that was GREEN under tiered acceptance returns to AMBER until the new proof lands.

## Anti-patterns

- **Implicit tiering** — "we'll deep-test the important ones and smoke-test the rest" without writing down which is which. Operator-trade-off is never explicit; coverage becomes wishful.
- **Hand-maintained tier lists.** Drift = silent regression.
- **Smoke-proof masquerading as full proof** — a tier-2 variant's smoke test labeled "passed" in the report without the tier distinction noted. Hides the trade-off from anyone reading the report later.
- **Skipping the per-item-enable pattern.** Tiered acceptance without per-item enable means a bad tier-2 variant takes down all variants together. The trade-off is no longer mitigated.
- **Letting tier-2 enable on merge.** Bypasses the dormant-default safety. If tier-2 is enabled on merge, the smoke proof was effectively full-proof's responsibility; the trade-off was an illusion.

## What this skill does NOT cover

- The dormant-default + per-item-enable mechanism itself (covered by `dormant-flip-and-rollback`).
- The contract sections that document the tiering and the operator acknowledgement (covered by `autonomous-run-contract`).
- The gate scoreboard rows for the tiered gates (covered by `swarm-blockers-and-gate-scoreboard`).
- The cross-PR composition risk when tier-2 lands in multiple PRs (covered by `auto-merge-and-composition-safety`).
