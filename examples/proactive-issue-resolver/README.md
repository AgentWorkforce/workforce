# proactive-issue-resolver (v1, local, manually-triggered)

Local agent that turns a GitHub issue into a spec, hands the spec to the
[`@agentworkforce/ricky`](https://www.npmjs.com/package/@agentworkforce/ricky)
SDK to generate + run a workflow that opens a PR via
`@agent-relay/github-primitive`, and DMs the result to Slack.

**Important runtime note:** workforce `--mode dev` does NOT subscribe to live
GitHub events. The runtime reads NDJSON envelopes from stdin
(`packages/runtime/src/runner.ts:184`); live event ingress is a `--mode cloud`
feature that isn't wired up yet. So v1 is **manually-triggered per-issue** via
`trigger-issue.sh`, not background-subscribed.

This is actually a safer v1 — the agent only acts on issues you point it at,
not every issue opened in the repo.

The full event-subscribed end-to-end design (and the trust envelope / approval
gates that go with it) lives in [`SPEC.md`](./SPEC.md).

## Flow

```
trigger-issue.sh owner repo N
  → gh api repos/owner/repo/issues/N            (fetch real issue)
  → wrap as github.issues.opened envelope       (NDJSON)
  → pipe → agentworkforce deploy --mode dev     (runner consumes one envelope)
  → handler claims issue (`gh issue edit --add-label ricky-claimed`)
  → handler comments :robot: on the issue
  → claude harness investigates repo + writes spec.md
  → createRickySdk({cwd}).generateLocalWorkflow({ spec, run: true, autoFixAttempts: 3, bestJudgement: false })
  → Ricky-generated workflow opens PR via @agent-relay/github-primitive
  → Slack DM (or channel post) with PR URL on success, failure summary on hard fail
  → runner exits when stdin closes
```

## Prerequisites

| Check | Command |
| --- | --- |
| `gh` CLI authed | `gh auth status` |
| Workforce logged in | `cat ~/.agentworkforce/active.json` (should show a workspace UUID) |
| `agentworkforce` CLI on PATH | `which agentworkforce` |
| `jq` installed | `brew install jq` |
| Slack provider connected in Relayfile | `relayfile integration list` should show `slack` |
| `ricky` installed in this dir | `ls node_modules/@agentworkforce/ricky/dist/index.js` |

## Install

```sh
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT/examples/proactive-issue-resolver"
npm install
```

This pulls `@agentworkforce/ricky` into the local `node_modules`. esbuild (used
by the workforce bundler) leaves `@agentworkforce/runtime` external but bundles
`@agentworkforce/ricky` inline — see
`packages/deploy/src/bundle.ts:62`.

## Configure

| Var | Effect |
| --- | --- |
| `PROACTIVE_SLACK_USER` | DM this Slack user ID (preferred for v1). |
| `PROACTIVE_SLACK_CHANNEL` | Post in this Slack channel ID. |
| `PROACTIVE_USE_CLOUD` | `true` → dispatch via `ricky.generateCloudWorkflow` instead of `generateLocalWorkflow`. Requires `AGENTWORKFORCE_TOKEN` + `AGENTWORKFORCE_WORKSPACE_ID`. Today the Ricky cloud executor returns `runtime-not-wired`; this branch surfaces that as a hard fail. See [`specs/cloud-mode-stub.md`](./specs/cloud-mode-stub.md). |
| `AGENTWORKFORCE_TOKEN` | Cloud bearer token. Required iff `PROACTIVE_USE_CLOUD=true`. |
| `AGENTWORKFORCE_WORKSPACE_ID` | Cloud workspace ID. Required iff `PROACTIVE_USE_CLOUD=true`. |

If both Slack vars are set, `PROACTIVE_SLACK_USER` wins.

## Run (right-now path)

From the repo you want the PR opened against (so the sandbox cwd is that
repo's checkout):

```sh
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"       # or any repo
PROACTIVE_SLACK_USER=U0ADJH4P83T \
  "$REPO_ROOT/examples/proactive-issue-resolver/trigger-issue.sh" \
  AgentWorkforce workforce 123
```

What happens:

1. `gh` fetches issue #123 and the repo metadata.
2. The script wraps both in a `github.issues.opened` envelope and pipes it to
   `agentworkforce deploy ... --mode dev`.
3. The handler adds the `ricky-claimed` label to issue #123 and acquires a
   deterministic Git ref lock before dispatch.
4. Handler comments `:robot: Proactive agent picked up #123. Investigating…`.
5. Spec gets written to `.proactive/issue-123-spec.md`.
6. Ricky generates and runs `workflows/generated/resolve-issue-workforce-123.ts`.
7. On success a PR is opened; Slack DM with PR URL.
8. The runner exits when stdin closes.

## Validate without running

```sh
REPO_ROOT=$(git rev-parse --show-toplevel)
agentworkforce deploy \
  "$REPO_ROOT/examples/proactive-issue-resolver/persona.json" \
  --mode dev --dry-run
```

Should print `ok: proactive-issue-resolver (dry-run)`. The persona is checked
against this output today.

## What was sanity-checked

- `agentworkforce` CLI v3.0.14 installed at `~/.local/share/mise/installs/node/22.22.1/bin/agentworkforce`.
- `~/.agentworkforce/active.json` shows an active workspace.
- `gh auth status` shows logged-in `khaliqgant` with `repo` scope.
- `agentworkforce deploy ... --mode dev --dry-run` returns `ok`.
- Handler signature matches `packages/runtime/src/types.ts:259`:
  `handler((ctx, event) => ...)`.
- Envelope shape matches `RawGatewayEnvelope` in
  `packages/runtime/src/shim.ts:17`; type `github.issues.opened` splits to
  source=github, type=issues.opened, payload=resource.
- `--mode dev` pipes parent stdin to runner stdin
  (`packages/deploy/src/modes/dev.ts:57`), so single-envelope stdin pipe →
  single dispatch → runner exits.
- esbuild bundles `@agentworkforce/ricky` inline; `@agentworkforce/runtime`
  stays external (`packages/deploy/src/bundle.ts:62`).
- Intent `relay-orchestrator` is in `PERSONA_INTENTS`
  (`packages/persona-kit/src/constants.ts:50`).
- Persona must have `cloud: true` to be opt-in to `deploy` (even for `--mode
  dev`); we set it.

## v1 limitations (deferred to v2 — see SPEC.md)

- **Manual trigger only.** No auto-subscription to live GitHub webhooks; that
  needs `--mode cloud` ingress (not wired) or a local Relayfile-backed event
  bridge.
- **Label + Git ref claim only, no in-flight registry.** If the persona crashes
  between claim and dispatch, manual cleanup is required (`gh issue edit
  --remove-label ricky-claimed` and delete the `agentworkforce/locks/...` ref).
- **No trust envelope.** v1 ships a PR for every triggered issue regardless
  of label or path. v2 reads `.proactive/trust-policy.yaml`.
- **No human approval gate.** v2 adds a `:thumbsup:` reactji gate.
- **No PR verification.** v2 GETs the PR to confirm `Closes #N` and
  non-default branch.
- **Single-attempt Ricky run.** No retry on hard fail.

## Files

| File | Purpose |
| --- | --- |
| `persona.json` | Workforce persona definition. |
| `agent.ts` | Handler. |
| `package.json` | Pulls `@agentworkforce/ricky` into local node_modules. |
| `trigger-issue.sh` | Manual trigger: `owner repo N` → envelope → deploy. |
| `SPEC.md` | v2 end-to-end design (event subscription, trust envelope, etc.). |
