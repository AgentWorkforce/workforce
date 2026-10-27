---
name: auto-merge-and-composition-safety
description: Use before auto-merging any PR in an autonomous run, and between consecutive merges that touch overlapping code. Covers the per-PR auto-merge bar (live CI verification, substantive review by area, bot-finding stale-vs-actionable triage) and the cross-PR composition discipline (serialize through green main, rebase + re-CI between merges, dormant-safety audit, force-reset over half-merged commits).
---

# Auto-merge and composition safety

Per-PR CI does not catch cross-PR interactions. Two PRs that each pass CI in isolation can compose into a broken main — the `pg`-in-Worker break (#757 + #758), the duplicate-helper break (#769 + #779), the rename-vs-delete break (#785 + #782). All three were composition-time failures: each PR was individually green, the composition was red. The discipline that prevents them is **serialize merges through green main + rebase + re-CI before merging the next**.

This skill covers the discipline. It is the per-PR auto-merge bar plus the cross-PR composition rules.

## When to invoke

- About to auto-merge a PR under an autonomous-run contract.
- About to merge a second PR within minutes/hours of a first that touched related code.
- About to ship a fix to a review comment that might break parity with the rest of the test suite.
- About to address a CodeRabbit / Devin / Codex bot finding.

## Part 1 — The per-PR auto-merge bar

These conditions are AND-ed. Any one failing = not authorized to merge; either fix or escalate.

### 1. CI status verified LIVE at merge time

`gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup` against the **current head SHA**, not a snapshot from earlier in the session. State snapshots go stale fast (a check can flip RED in a minute on a flaky job; a new commit can land on main and demote a `CLEAN` PR to `BEHIND`).

- `mergeable: MERGEABLE` AND `mergeStateStatus: CLEAN`.
- Any of `BLOCKED`, `BEHIND`, `UNSTABLE`, `DIRTY`, `HAS_HOOKS` → not authorized. Resolve the underlying cause first (rebase, re-run flaky check, address blocking review).
- Required-status checks: every one in the `statusCheckRollup` is `SUCCESS` or `NEUTRAL`. A single `FAILURE`, `ERROR`, `CANCELLED`, or `PENDING` blocks.
- Re-verify within the last 60 seconds before the merge command runs. If you queried 5 minutes ago, query again.

### 2. Substantive review by area

A wave-through ("LGTM, merging") is not a review. The review must touch the areas applicable to the change. The full menu (apply the items that apply):

- **F0-class correctness.** Does the headline behavioral change actually do the thing? Read the smallest unit of behavior end-to-end — input → branching → output. Trace one real value through the new code path.
- **Dormant-safety / default-disabled.** A new code path added in a feature PR must be unreachable in production by default. No caller turns it on. The cutover happens in a separate, intentional flip (see `dormant-flip-and-rollback`). If the PR enables-on-merge, that's a contract violation — escalate.
- **Worker-bundle safety.** If the PR touches code that ends up in a Cloudflare Worker bundle, run the import-safety check (e.g. cloud's `tests/b1-worker-import-safety.test.ts` locally). The fix for a B1 failure is always an import-graph split, never an `external` allowlist.
- **Idempotency.** Webhook and queue handlers must handle redelivery without duplicate side effects. Look for a dedup key (durable, content-derived, persistent across restarts — not an in-memory `Set`).
- **Rollback path preserved.** Can the change be undone by reverting this PR and (where applicable) flipping the corresponding flag back? If the migration is one-way (e.g. dropping a column the old code reads), the PR needs a separate documented backout, and the operator must explicitly accept the irreversibility.
- **Failure-class regression test runs RED without the fix.** Proof-of-non-vacuity: revert just the fix locally, run the test, confirm it fails. If it passes anyway, the test isn't testing what you think it is.
- **Standing-constraint compliance.** SST secret seven-place wiring complete; drizzle journal entry added; integration adapter registry updated; relayfile digest contract honored (terminal states preserved, not modeled as deletions); whatever applies in the repo.

The review must produce written evidence — a PR comment, a `/tmp/<pr>-review.md`, or the rollup file (see file-based reporting below). "I checked" without artifacts is not substantive.

### 3. Bot-finding triage: stale-vs-actionable

CodeRabbit, Devin, and similar bots post comments tied to a specific commit SHA. By the time you review, those comments may already be moot — the PR has since added the fix, refactored away the criticized code, or rebased onto a head that no longer contains the snippet.

For every bot finding:

1. **Identify the commit it was posted against.** GitHub renders this; CodeRabbit shows the source.
2. **Look at the same file at the current PR head.** Use `gh pr diff <n>` filtered to the file, or check out the head branch.
3. **Decide: stale-resolved, stale-superseded, or actionable.**
   - **Stale-resolved:** the criticized code no longer exists or already incorporates the fix the bot asked for. Reply on the PR documenting the audit: "Checked at HEAD `<sha>`; the criticized `foo()` call was replaced by `bar()` in commit `<sha>` which incorporates the dedup the comment requested. Resolving."
   - **Stale-superseded:** the broader area was refactored; the specific concern no longer applies in the new structure. Same reply pattern — be specific about what replaced it.
   - **Actionable:** still present at HEAD, the concern is real. Address before merge or escalate.

The point: do not silently dismiss bot findings, and do not silently wave them through. Audit each, reply on the PR with the audit, then merge.

### 4. Worktree hygiene

PR work happens in a dedicated worktree. Never co-mingle uncommitted changes from another branch into a PR commit. Verify with `git status --porcelain` (not `git diff --quiet`, which misses staged changes) before committing.

### 5. Never merge on red

No `--admin` past failing required checks. If a check is broken because of inheritance from main (the same check failed on the merge-base), document the inheritance:

```bash
git fetch origin main
git diff origin/main -- <suspect-file>
gh run view <main-run-id> --log | grep -A5 <failure-signature>
```

Then seek explicit operator waiver. Inherited failures are not auto-waivable.

### 6. Don't ship half-fixes

If a fix to address a review comment makes a previously-passing oracle (the rest of the parity suite, the documented contract, the schema-validation suite) start failing — abort the fix. Document on the PR: "Attempted fix X for review comment Y; it breaks the broader parity oracle Z because [reason]. Scope is larger than this PR. Recommend [open follow-up issue / address in a dedicated PR / accept the original review comment as a known limitation]."

A half-fix that papers over the reviewer's concern at the cost of another invariant is worse than no fix.

## Part 2 — Cross-PR composition safety

This is the discipline that prevents composition-time failures. Apply between every two merges in an autonomous run that touch overlapping code.

### Serialize through green main

After merging PR A:

1. Wait for main's post-merge CI to complete and turn GREEN.
2. Rebase PR B onto the new main: `git fetch origin main && git rebase origin/main`.
3. Re-push and re-trigger PR B's CI.
4. Re-verify PR B against the §1 bar with the new CI run.
5. Only then merge B.

This is slower than parallel merges. It is the only reliable way to catch the composition class of bugs.

### Cross-PR dormant-safety composition audit

When two PRs each add to the same dormant path (a new feature behind a flag, with both PRs contributing to the new code), audit the composition before merging the second:

- Does the combined code in the dormant path compile and pass the parity test suite?
- Does any caller of the dormant code path exist anywhere in the tree? `git grep` the new symbol name across the full repo — if anything references it under a default-enabled branch, dormant-safety is broken.
- Did PR B accidentally remove a guard PR A added? Re-read the combined diff against the merge-base of both.

### Force-reset over half-merged commits

If a conflict resolution shipped broken — merge markers in source, a critical helper deleted, a rename-vs-delete misresolution that lost a file — **force-reset the branch to its pre-rebase head and dispatch the proper rebase to the original implementer agent**. Do not try to fix-forward a half-merge.

```bash
git reflog show <branch>
git reset --hard <pre-rebase-sha>
git push --force-with-lease origin <branch>
```

Then re-run the implementer with the full diff context. Fix-forward attempts on a corrupted rebase compound the damage — the next agent inherits a tree that diverges from history in non-obvious ways.

## Part 3 — File-based reporting

Agent-to-agent message history truncates around 150 characters per turn in some channels; the channel cannot reliably carry full reviews or verdicts. The convention:

- Each workstream writes its status to `/tmp/ws-<name>-status.md` with the full review/verdict/evidence.
- The lead aggregates into `/tmp/<run-name>-rollup.md`.
- The orchestrator surfaces to the operator only on action points (gate flips RED, escalation needed, flip authorized).

The channel carries pointers ("review at /tmp/ws-foo-status.md"), not contents. This survives truncation and lets each agent re-read another's full work without re-asking.

## Anti-patterns

- Snapshot-and-merge: querying CI status at the start of the review and merging an hour later without re-querying.
- Wave-through reviews on substantive changes: "LGTM, all checks green, merging."
- Silently dismissing bot findings without auditing against HEAD.
- Merging A and B in parallel because each is individually green.
- Fix-forwarding a half-merged rebase.
- Papering over a review comment with a fix that breaks an invariant elsewhere.

## What this skill does NOT cover

- Authoring the contract that grants auto-merge authority (covered by `autonomous-run-contract`).
- The flip itself and rollback (covered by `dormant-flip-and-rollback`).
- The diagnostic-first protocol when fixes keep failing (covered by `instrument-dont-guess`).
- Scoreboard maintenance across the run (covered by `swarm-blockers-and-gate-scoreboard`).
