# Proactive Issue Resolver — v2 Spec

End-to-end version of the v1 example in this directory. v1 ships the "happy
path" only — single repo, no dedup, no approval gate, single trigger, single
notification. v2 is the production-shaped version that can be turned on against
real repos without supervision.

> v1 = "demo that the wires connect."
> v2 = "agent we trust to ship code into our repos unattended within a defined
> trust envelope."

---

## 1. Goals & non-goals

### Goals

- Turn a newly opened GitHub issue into a high-quality, mechanically-verifiable
  implementation spec without human intervention.
- Hand that spec to Ricky to produce a PR that closes the issue, using
  `@agent-relay/github-primitive` as the GitHub action layer.
- Apply a **trust envelope**: which issues auto-ship, which require human
  approval, which never auto-ship.
- Be observable end-to-end: every issue has a status file, every Ricky run has
  an artifact, every terminal state surfaces to Slack.
- Be idempotent: a delivered-twice event, a restarted persona, or a
  human re-trigger never produce duplicate PRs.
- Run identically in `--dev` (local) and cloud once Workforce cloud deploy is
  wired up. No handler code changes between modes.

### Non-goals (v2)

- Owning the long-running implementation work. Ricky does the codework; the
  proactive agent only handles ingestion, investigation, spec authorship,
  dispatch, and reporting.
- Generic chat. The agent does not respond to issue comments, mentions, or
  reactions in v2 (deferred to v3).
- Multi-issue coordination (linked issues, blocked-by chains). v2 treats each
  issue as independent.
- Reviewing the resulting PR. A separate review-agent persona owns that loop.

---

## 2. Surfaces

| Surface | v2 scope |
| --- | --- |
| GitHub issues | Primary input. `issues.opened` + `issues.labeled` (for `spec-approved` gate + `ricky-retry` re-trigger). |
| Linear issues | Optional secondary input via `issue.created` Relayfile trigger; same downstream pipeline. |
| Slack `/spec` slash command | Manual handoff path. Posts a spec into Slack; reactji approval moves it through the same dispatch. |
| Slack notify | Terminal-state notifications only: `PR opened`, `approval needed`, `hard fail`. No chatter. |
| Relayfile mount | Source of truth for in-flight registry, status files, rollup, and audit trail. |

Slack is a notification surface and a `/spec` ingress, not the agent's identity.

---

## 3. Trust envelope (auto-ship policy)

Every issue is classified before any work begins. The classifier is part of the
investigate prompt and produces one of three trust levels:

| Trust | Trigger | Behavior |
| --- | --- | --- |
| **auto** | Labels include any of `bug`, `chore`, `docs`, `typo`, `flake-fix`. Sensitive paths NOT touched. | Spec written → Ricky run → PR opened → Slack notify. No human gate. |
| **gated** | Labels include `feat`, `refactor`, or no label and reporter is not in `auto-trusted-reporters`. | Spec written → posted to issue + Slack with `:thumbsup:` reactji gate → on approval, dispatch to Ricky. On `:x:` reactji, mark `ricky-declined` and stop. |
| **never** | Spec's proposed `Files to touch` intersects `sensitive-paths` allowlist (e.g. `infra/`, `**/auth/**`, anything matched by `.proactive/no-auto-ship.txt`) or the issue body mentions "production data" / "customer data" / "secrets". | Spec written → posted with `requires-human` label. No dispatch under any circumstance until a human re-labels. |

The trust policy lives in `.proactive/trust-policy.yaml` checked into the
watched repo so the policy travels with the repo, not the agent.

Sample policy file:

```yaml
auto-labels: [bug, chore, docs, typo, flake-fix]
gated-labels: [feat, refactor]
auto-trusted-reporters: [khaliqgant, dependabot[bot]]
sensitive-paths:
  - "infra/**"
  - "**/auth/**"
  - ".github/workflows/**"
  - "packages/*/migrations/**"
sensitive-phrases:
  - "production data"
  - "customer data"
  - "secret"
  - "credential"
```

---

## 4. Pipeline

```
[claim] → [investigate] → [classify] → [spec] → [gate?] → [dispatch] → [verify] → [notify]
```

### 4.1 Claim

- Add label `ricky-claimed` to the issue (atomic via GitHub label API; if it
  already exists, exit — another worker has it).
- Write `/relayfile/proactive/inflight/<repo>__<number>.json` with `state: claimed`,
  timestamp, persona run ID, and event delivery ID.
- This is the **only** dedup mechanism. Process state is untrusted; mount state
  is the source of truth.

### 4.2 Investigate

Claude harness, prompt includes:
- Issue title, body, labels, reporter.
- Repo tree (truncated to first ~2000 paths).
- Greps the harness chooses to run (open-ended; harness has filesystem access).
- The trust policy file content.

Output: a draft spec markdown (sections defined in §4.4) **plus** a
classification block at the top:

```yaml
---
classification: auto | gated | never
classification-reason: "labels include 'bug'; no sensitive paths in proposed diff"
proposed-files:
  - packages/backend/src/foo.ts
  - packages/backend/tests/foo.test.ts
---
```

### 4.3 Classify

Pure function over `(labels, reporter, proposed-files, trust-policy.yaml)`. The
classifier output OVERRIDES the harness's self-classification — the harness is
input, the policy file is authority. The classifier writes its decision into the
in-flight status file.

If the harness's self-classification disagrees with the policy result, both are
recorded and the policy result wins. (This catches harness drift: if the
harness ever starts marking `feat` work as `auto`, the policy file still gates
it.)

### 4.4 Spec

Spec format (committed to the issue as a comment + saved to
`/relayfile/proactive/specs/<repo>__<number>.md`):

```
# Spec: Resolve #<N> — <title>
## Problem
## Proposed approach
## Files to touch
## Acceptance
  - mechanical bullets only
  - each bullet must be a command output, a file diff invariant, or a test name
## Out of scope
## Rollback
  - the one-line revert command if the PR ships and breaks something
## PR shipping requirement
  - The generated workflow MUST open a PR using @agent-relay/github-primitive
    against <owner>/<repo>. Title: "Fix #<N>: <title>". Body MUST include
    "Closes #<N>".
```

The **Acceptance** section is the gate Ricky's autoFix loop reads. It must be
mechanical, not narrative. If the harness produces a narrative acceptance
section, the spec is rejected and the harness is re-run with a stricter prompt
once; second failure → `requires-human` and stop.

### 4.5 Gate (if classification = gated)

- Post spec to issue as a comment.
- Slack notify: `Spec ready for #N. React :thumbsup: to ship or :x: to skip.`
- Watch the issue / Slack for the reactji. On `:thumbsup:` from a user in
  `auto-trusted-reporters`, advance to dispatch.
- 24h timeout → auto-skip with `requires-human` label.

### 4.6 Dispatch

```ts
const ricky = createRickySdk({ cwd });
await ricky.generateLocalWorkflow({
  spec,
  workflowName: `resolve-issue-${repo}-${number}`,
  run: true,
  autoFixAttempts: 3,
  bestJudgement: false,
});
```

The generated workflow MUST contain at least one `createGitHubStep` from
`@agent-relay/github-primitive` performing a `createPR` action. Ricky's own
generation guardrails (see
`ricky/src/product/generation/workforce-persona-writer.ts:1451`) already
enforce this when the spec contains "open a pull request" — v2 relies on that
contract, with a post-hoc check that the generated workflow file mentions
`@agent-relay/github-primitive` before running.

### 4.7 Verify

After Ricky returns:
- Parse `result.prUrl` (or scan output for a github.com/.../pull/N URL).
- If a PR URL is present: GET the PR via github-primitive, confirm:
  - Body contains `Closes #<N>`.
  - PR is open.
  - PR's branch is not `main` / not the repo default.
- If any check fails: treat as a hard fail.

### 4.8 Notify

Three terminal states surface to Slack. Nothing else does.

- **PR opened** — `:white_check_mark: Issue #N (repo): PR opened <url>`.
- **Approval needed** — `:hourglass: Spec ready for #N. <issue-url>. React on the issue or in this thread.`
- **Hard fail** — `:x: #N could not be auto-resolved. Reason: <one line>. Artifact: <path>. Issue: <url>.`

Slack messages always include the issue URL so the human can drill in.

---

## 5. Idempotency & dedup

- **Issue-level claim:** `ricky-claimed` label. Atomic via GitHub. The agent
  refuses to start work on an issue that already has it.
- **Event-level dedup:** Relayfile webhook delivery IDs are stored in
  `/relayfile/proactive/processed-events/<delivery-id>`. Already-seen IDs are
  dropped without action.
- **In-flight registry:** `/relayfile/proactive/inflight/<repo>__<number>.json`
  carries the live state (`claimed`, `investigating`, `gated`, `dispatched`,
  `pr-opened`, `failed`, `requires-human`). The handler reads this on entry
  and refuses to advance past a state that has already been recorded.
- **PR-level dedup:** Before dispatching, search the repo for open PRs whose
  body mentions `Closes #<N>`. If one exists, skip dispatch and mark the issue
  state `pr-already-exists`.

---

## 6. Failure handling

| Failure | Action |
| --- | --- |
| Investigate harness errors | Retry once with stricter prompt. Second failure → `requires-human` label, hard-fail notify. |
| Spec acceptance section narrative-not-mechanical | One re-run with stricter prompt; second failure → `requires-human`. |
| Ricky run returns no PR URL | Hard-fail notify with artifact path. Do not retry automatically — that's a `ricky-retry` label trigger for the human. |
| Ricky run produces PR but verification fails (no `Closes #N`, branch is default, etc.) | Comment on PR + issue; close the PR; hard-fail notify. |
| Two consecutive failed auto-fix attempts on the same symptom inside Ricky | Ricky's own `autoFixAttempts: 3` covers this; v2 trusts Ricky's internal loop and does not double-handle. |
| Persona crashes mid-flight | In-flight status file remains. On restart, the agent loads in-flight entries, refuses to re-claim issues, and posts a `:warning: crashed mid-flight on #N` Slack notify so a human can intervene. |

The "instrument-don't-guess" pattern from autonomous-actor applies in spirit:
if two consecutive different issues fail at the same pipeline stage (e.g. spec
acceptance section keeps coming out narrative), the third action is to dump a
diagnostic (the literal harness output) to `/relayfile/proactive/diagnostics/`
and Slack-notify — not to keep tweaking the prompt blind.

---

## 7. Observability

All persistent state lives under `/relayfile/proactive/`. The channel
(Slack/issue comments) only carries pointers + terminal states.

```
/relayfile/proactive/
├── inflight/
│   └── <repo>__<number>.json       # current state per issue
├── specs/
│   └── <repo>__<number>.md          # finalized spec
├── processed-events/
│   └── <delivery-id>                # empty file = seen
├── rollup.md                        # daily rollup of activity
├── diagnostics/                     # when investigation stalls
│   └── <timestamp>-<repo>-<number>.json
└── trust-policy.yaml                # checked-in policy snapshot (mirror)
```

`rollup.md` is regenerated on every run completion:

```
# Proactive Issue Resolver — Rollup

## Last 24h
- 7 issues claimed
- 5 PRs opened (auto)
- 1 gated awaiting approval
- 1 hard-failed: #842 (artifact: workflows/generated/resolve-issue-foo-842.ts)

## Open in-flight
- #842 — failed at Ricky run (3h ago)
- #851 — gated, awaiting :thumbsup: (45m ago)
```

---

## 8. Configuration surface

Three layers, in precedence order (highest wins):

1. Per-event env on the persona deploy (`PROACTIVE_SLACK_USER`, etc.).
2. `.proactive/trust-policy.yaml` checked into the watched repo.
3. Built-in defaults in the persona.

The watched repo's `.proactive/` directory is the operator-facing config — the
agent reads it fresh on every event, so policy changes don't require a persona
redeploy.

```yaml
# .proactive/trust-policy.yaml (full schema)
version: 1
auto-labels: [bug, chore, docs, typo, flake-fix]
gated-labels: [feat, refactor]
auto-trusted-reporters: []
sensitive-paths: []
sensitive-phrases: []
max-issues-per-hour: 3       # rate limit auto-ship
gate-timeout-hours: 24
slack:
  notify-channel: C0123ABCD
  approval-reactji-users: [khaliqgant]
ricky:
  auto-fix-attempts: 3
  best-judgement: false
```

---

## 9. Cloud parity

The persona ships `cloud: true` ready. When Workforce cloud deploy lands:

- Same `agent.ts`. No handler changes.
- Relayfile mount becomes the cloud mount; `/relayfile/proactive/` paths
  unchanged.
- GitHub events arrive via Relayfile webhook ingress instead of `--dev` poll.
- `gh` CLI is replaced by github-primitive's cloud runtime mode (Nango token).
- Slack integration uses the workforce-managed Slack connection.

The only file that meaningfully changes is `persona.json` — drop `--dev`,
set `cloud: true`, and the rest carries through.

---

## 10. Telemetry & success criteria

v2 is "working" when, over a 30-day window across all watched repos:

- ≥ 80% of `auto`-classified issues result in a merged PR.
- 0 false-`auto` classifications (i.e. zero auto-shipped PRs touching
  `sensitive-paths`).
- Median wall time from `issues.opened` to PR opened ≤ 10 minutes.
- p95 wall time ≤ 30 minutes.
- 0 duplicate PRs for the same issue.
- 100% of hard-fails surface to Slack within 60s of the failure.

These thresholds gate the move from "running against one private repo" to
"running against the workforce repo itself."

---

## 11. Open questions

- **Cross-issue dedup.** If issue #842 and #851 propose overlapping diffs,
  whose PR wins? v2 punts: first PR opens, second issue's dispatch sees an open
  PR overlapping its proposed files and notifies-not-dispatches.
- **Reviewer integration.** Should the proactive agent auto-request review from
  a configured reviewer? Defer to v3 — for v2, the existing review-agent
  persona picks up the PR via `pull_request.opened`.
- **Linear ↔ GitHub bridge.** v2 supports Linear ingress, but does it open
  GitHub PRs only, or also push status back to the originating Linear issue?
  v2 = GitHub PR only; status push to Linear is v3.
- **Spec versioning.** If a human edits the spec comment on the issue, does
  the agent pick up the edit and re-dispatch? v2 = no, edits are ignored after
  dispatch. v3 = `spec-edited` label re-triggers a bounded re-run.

---

## 12. v1 → v2 delta checklist

The v1 example in this directory implements roughly the bold rows below:

- [x] `issues.opened` trigger + handler.
- [x] Claude harness investigation producing a spec.
- [x] Ricky SDK dispatch with `run: true, autoFixAttempts: 3`.
- [x] Slack notification on terminal state.
- [x] Issue comment trail (claim + result).
- [ ] `ricky-claimed` label-based atomic claim.
- [ ] `.proactive/trust-policy.yaml` reading + classification.
- [ ] Gated path with reactji approval.
- [ ] Sensitive-path / sensitive-phrase blocking.
- [ ] Relayfile-backed in-flight registry + processed-events dedup.
- [ ] PR verification (`Closes #N`, branch != default).
- [ ] Rollup file + diagnostics dump.
- [ ] Linear ingress.
- [ ] Slack `/spec` ingress.
- [ ] Rate limiting + gate timeout.
- [ ] Cloud-mode parity test.
