---
name: slack-relayfile-writeback-debugging
description: Use when an outbound Slack writeback (channel post, thread reply, or DM) silently fails to deliver — no error, no dead-letter. Covers the writeback pipeline, the relayfile ops-API getOp recipe to read the persisted lastError, where the Slack error actually surfaces (NOT the consumer logs), the missing_scope/im:write 3-place fix, cf-vs-bridge dispatch, and duplicate/silent-send pitfalls.
---

# Debugging Slack writeback non-delivery (relayfile ↔ cloud)

You are diagnosing why an outbound Slack writeback did not reach Slack. A writeback is a JSON file dropped under a mounted command root (`…/channels/<id>__<slug>/messages[/<ts>/replies]/<file>.json` or `…/users/<U>/messages/<file>.json`). Confirm with evidence, never a hypothesis.

## Pipeline (cloud, AgentWorkforce/cloud)

```
local file → mount pushes up → ingest creates a writeback OP → WRITEBACK_QUEUE
  → batch executor → cf OR bridge provider → Slack API
```
- Ingest → op: `packages/relayfile/src/durable-objects/handlers/ops.ts` recordMutations (~1043-1101) makes a writeback op for ANY `agent_write`; `provider_sync` origin is suppressed (returns "succeeded" with NO op).
- Queue consumer (batch): `packages/relayfile/src/queue-consumer.ts:71` → `executeProviderWritebackBatch`. **It logs ONLY `writeback.start`** (`provider-executor.ts:258`) — never the Slack error. So `wrangler tail relayfile-writeback-consumer` confirms dispatch but never shows why it failed.
- Path allowlist: `provider-executor.ts` getUnsupportedReason (951-1010); `SLACK_UPSERT_WRITEBACK_PATH` (1203-1205) — includes `users/<U>/messages` (DM path allowed).
- cf-vs-bridge fork: `:132` (single) / `:288` (batch). Default `writeback_dispatch_via = bridge` (`workspace.ts:1062`); cf has the idempotency guard the bridge lacks (cloud#1985).

## THE diagnostic: read the op's lastError (ground truth)

```
curl -H "Authorization: Bearer <token from <mount>/.relay/creds.json>" \
     -H "X-Correlation-Id: anything" \
     https://api.relayfile.dev/v1/workspaces/<rw_id>/ops/<opId>
```
- ⚠️ `X-Correlation-Id` is **required** — without it: HTTP 400 `missing X-Correlation-Id header`.
- base = `DEFAULT_RELAYFILE_BASE_URL` = `https://api.relayfile.dev`.
- `<rw_id>`: grep the mount's `.relay/state.json` for `"workspaceId"`.
- token: `.relay/creds.json` `token` (JWT, has `ops:read`; re-minted ~hourly — re-read it).
- `<opId>`: from the `writeback.start` log, or list `…/ops?limit=N` and match `path`.
- Result: `{status, lastError, attemptCount}`. `status:failed` + `attemptCount:0` = a permanent (non-retryable) failure that is **not dead-lettered and not surfaced** — the "silent, no error" signature.
- The error ALSO surfaces as the cf audit event `console.info("[relayfile] writeback audit event", {event})` in **cloud-web-worker** (`event.metadata.slackError`) — but getOp is faster + persisted.

## Known failure modes → fix

- **`lastError: missing_scope` on a DM** → the Slack app lacks **`im:write`**. DM send calls `conversations.open` (needs `im:write`) before `chat.postMessage`; channels only need `chat:write` (so channels work, DMs don't). `missing_scope` isn't retryable (`providers/slack.ts:476-485`) → permanent_failure → silent. **Fix = 3 places, in order:** (1) Slack app → Bot Token Scopes → add `im:write`(+`mpim:write`) → reinstall; (2) **Nango dashboard** → add the same to the `slack-relay` integration's requested scopes (the OAuth request set lives here, NOT in the repo — easy to miss); (3) re-OAuth/reconnect (existing tokens get no retroactive grant). Verify: re-fire → getOp `succeeded`.
- **Duplicate posts** → the legacy bridge path lacks the cf idempotency guard. Delete the command file after confirmed delivery; migrate the workspace to cf (cloud#1977).
- **Silently never sent (looks clean)** → on a poll mount the push is ~30s-cadence. The workspace `revision` counter is GLOBAL (not a dispatch signal); deleting the command file before a push cycle uploads it = silent non-delivery. Confirm dispatch by: operator receipt, OR the file surviving ≥1–2 cycles with `pendingWriteback` 1→0, OR (top-level) the bot echo in the flat `messages/<ts>/` tree. Thread REPLIES never echo.
- **mirror does NOT auto-delete dispatched command files** — manual delete-after-send is still required, or a future `clearState` re-dispatches them.

## Don't
- Don't conclude from `wrangler tail` of the consumer (it only logs `writeback.start`).
- Don't blame adapter version: `@relayfile/adapter-slack` 0.3.9 already resolves DM→post_dm; cloud#1997 was a READ-side fix. The send path is present + deployed — the gap is almost always scope/config, confirmed via getOp.
