# `@agentworkforce/mcp-workforce`

An MCP server that exposes workforce primitives (workflows, memory,
integration clients) to a harness running inside a workforce sandbox.

The workforce runtime spawns this server automatically when a handler
calls `ctx.harness.run(...)` — the harness (Claude Code, Codex, opencode)
then has tool access to:

| Tool | Description |
|---|---|
| `workflow.run` | Invoke a workforce cloud workflow by name. Returns `{ runId, status }`. |
| `workflow.status` | Poll a previously-started workflow run for status/output. |
| `memory.save` | Persist a memory entry to the workspace memory bag. |
| `memory.recall` | Semantic search over the workspace memory bag. |
| `integration.github.comment` | Post a comment on a GitHub issue/PR. |
| `integration.github.createIssue` | Create a GitHub issue. |
| `integration.github.upsertIssue` | Update an open issue matching `matchTitle`, or create one. |
| `integration.github.getPr` | Fetch a PR with title, body, refs, author, and unified diff. |
| `integration.github.postReview` | Post a PR review (COMMENT / APPROVE / REQUEST_CHANGES). |

## Running stand-alone

```sh
export WORKFORCE_WORKSPACE_ID=ws_demo
export WORKFORCE_RUNTIME_TOKEN=<workspace-token>          # required for workflow.*
export SUPERMEMORY_API_KEY=<key>                          # required for memory.*
export WORKFORCE_INTEGRATION_GITHUB_TOKEN=ghp_...         # required for integration.github.*

npx @agentworkforce/mcp-workforce
```

The server speaks MCP over stdio.

## Persona-side wiring

The runtime injects this server automatically when `ctx.harness.run`
spawns a harness. Personas that want to declare it manually can use:

```jsonc
"mcpServers": {
  "workforce": { "command": "npx", "args": ["@agentworkforce/mcp-workforce"] }
}
```

## Configuration

| Env var | Purpose | Required when |
|---|---|---|
| `WORKFORCE_WORKSPACE_ID` | Workspace this server is bound to | always |
| `WORKFORCE_PERSONA_ID` | Persona id (logged for audit) | optional |
| `WORKFORCE_RUNTIME_TOKEN` | Workspace-scoped token for cloud API calls | `workflow.*` |
| `WORKFORCE_CLOUD_URL` | Override cloud base URL | optional |
| `SUPERMEMORY_API_KEY` | Memory adapter credentials | `memory.*` |
| `SUPERMEMORY_ENDPOINT` | Override supermemory endpoint | optional |
| `WORKFORCE_INTEGRATION_<PROVIDER>_TOKEN` | Direct provider token | `integration.<provider>.*` |

Tools that lack their required env throw a clear setup error at first
call — the server itself still boots so partial wiring is debuggable.
