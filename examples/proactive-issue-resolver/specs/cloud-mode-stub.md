# Spec: Cloud-mode dispatch stub for proactive-issue-resolver

## Problem

`agent.ts` calls `ricky.generateLocalWorkflow` unconditionally. When the Ricky
cloud executor lands (today
`ricky/src/cloud/api/generate-endpoint.ts:defaultCloudExecutor` is a stub that
returns `runtime-not-wired`), swapping to `generateCloudWorkflow` should be one
env-var flip, not a rewrite. We want the wiring landed now so the swap is
mechanical when the runtime is ready.

The change must:

- Cost ~30 lines and not alter any local-path behavior today.
- Surface the cloud path's current "not wired" response as a hard fail through
  the same Slack notification path as any other Ricky failure — no silent
  swallowing, no special UI.
- Match the cloud SDK call shape (`{ auth, workspace, body }`) so the only file
  that changes when cloud lands is this one.

## Proposed approach

1. Extract the Ricky call into `dispatchToRicky(spec, target)` returning a
   normalized `{ prUrl: string | null, failureDetail: string, raw: unknown }`.
2. Inside `dispatchToRicky`, branch on `PROACTIVE_USE_CLOUD === 'true'`.
   - **Local branch (default):** existing `generateLocalWorkflow` call.
   - **Cloud branch:** read `AGENTWORKFORCE_TOKEN` and
     `AGENTWORKFORCE_WORKSPACE_ID` from env, build a `CloudGenerateRequest`,
     call `ricky.generateCloudWorkflow`, then run the same URL-scan over the
     response. If either env is missing, throw a precise error before calling
     Ricky.
3. The existing `extractPrUrl` and `summarizeFailure` helpers already scan
   arbitrary objects for a `github.com/.../pull/N` URL — keep them as the
   single normalization point.
4. Document the env vars in `README.md`.

## Files to touch

- `agent.ts` — add `useCloud()` + `dispatchToRicky()`, refactor existing call
  through it.
- `README.md` — one new row in the Configure table for the cloud env vars.
- `specs/cloud-mode-stub.md` — this file.

## Acceptance

- `npx tsc --noEmit -p examples/tsconfig.json`
  passes with no new errors.
- Running `trigger-issue.sh` with `PROACTIVE_USE_CLOUD` unset uses the local
  path (verified by reading agent.ts: the cloud branch is unreachable without
  the env var).
- Running with `PROACTIVE_USE_CLOUD=true` and the workforce envs unset throws
  `cloud dispatch requires AGENTWORKFORCE_TOKEN and AGENTWORKFORCE_WORKSPACE_ID`
  before any Ricky call.
- Running with `PROACTIVE_USE_CLOUD=true` and all envs set today reaches
  `ricky.generateCloudWorkflow`, which returns the `runtime-not-wired` stub
  response; that surfaces as a `:x:` Slack hard-fail with the cloud error
  payload in the failure detail. No PR is opened.
- `agentworkforce deploy ... --mode dev --dry-run` still returns `ok`.

## Out of scope

- Implementing the cloud executor itself (lives in `ricky/`, not this repo).
- Reading workforce credentials from `~/.agentworkforce/active.json` — explicit
  envs only, to keep the boundary clean.
- Polling the cloud `runReceipt.runId` to wait for completion — that becomes a
  follow-up when `generationMode: 'generate-and-run'` actually queues a run.
- Any behavior change on the local path.

## Rollback

`git revert` the agent.ts change. The local path is unchanged, so a revert
restores the exact behavior of the prior commit.
