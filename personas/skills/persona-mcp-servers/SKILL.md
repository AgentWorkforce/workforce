---
name: persona-mcp-servers
description: Use when authoring an AgentWorkforce persona's `mcpServers` field — covers the two spec variants (http/sse vs stdio), `$VAR` secret substitution, the claude/codex/opencode harness support matrix that constrains harness selection, and the `permissions.allow` pairing for `mcp__<server>` tools
---

# MCP servers for AgentWorkforce personas

You are advising an author writing the `mcpServers` field on an AgentWorkforce persona spec. The field declares which MCP servers the persona's harness session should attach to. Map of `serverName → spec`. The spec shape is uniform across harnesses — persona-kit translates per harness at spawn time.

## Two spec variants

**Remote (`http` or `sse`):**

```json
"mcpServers": {
  "notion": { "type": "http", "url": "https://mcp.notion.com/mcp" }
}
```

Optional `headers` map for authentication:

```json
"mcpServers": {
  "private-api": {
    "type": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer $MY_API_TOKEN" }
  }
}
```

**Local stdio binary:**

```json
"mcpServers": {
  "posthog": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@posthog/mcp"],
    "env": { "POSTHOG_API_KEY": "$POSTHOG_API_KEY" }
  }
}
```

## Secret substitution

Values inside `url`, `headers`, `command`, `args`, and `env` support `$VAR` / `${VAR}` substitution against the caller's process env at spawn time. **Use this for secrets — never hardcode API keys in the persona JSON.**

If a required field references an unset env var, persona-kit drops that entire `mcpServers.<name>` block at spawn time with a warning rather than booting with an obviously-broken config.

## Harness support matrix (drives harness selection when MCP is required)

| Harness | Support | How it works |
|---------|---------|--------------|
| `claude` | Fully wired | `mcpServers` is passed through verbatim via `--mcp-config` with `--strict-mcp-config`. The session sees only the persona's declared servers, never the user's local Claude Code config. |
| `codex` | Translated | Each server becomes repeated `--config mcp_servers.<name>.{command,args,env,url,http_headers}` TOML overrides. `stdio` and `http` both work; `sse` emits a warning and forwards the URL as-is because codex expects streamable-http endpoints. |
| `opencode` | Not wired | The build emits a warning and skips MCP entirely. Do not pick `opencode` for a persona that needs MCP servers. |

If the persona needs MCP, this constrains harness selection. Default to `claude` for MCP-heavy personas; choose `codex` only if you also need codex's reasoning ceiling and can live with the warning-on-sse caveat.

## Pairing with permissions

Pair `mcpServers` with `permissions.allow` to gate which of a server's tools the agent may invoke:

```json
"permissions": {
  "allow": ["mcp__notion", "mcp__posthog__projects-get"]
}
```

- `mcp__<server>` allows every tool exposed by that server.
- `mcp__<server>__<tool>` matches one specific tool.

Without an `allow` entry the harness uses its default permission policy for MCP — under `claude` that typically means prompts on first use, not auto-approve. For unattended runs, list the allowed tools explicitly.

## Pre-handoff checklist

- [ ] Is the harness `claude` (full support) or `codex` (translated)? If `opencode`, MCP will be silently dropped.
- [ ] Are all secrets (`api_key`, `token`, `password`) referenced via `$VAR` substitution, not hardcoded?
- [ ] Is `permissions.allow` set to the specific `mcp__<server>` (or `mcp__<server>__<tool>`) entries the persona actually uses, especially for unattended runs?
- [ ] For `stdio` servers: is the `command` (e.g. `npx`) actually available on the harness machine? If shipping in a container, is the binary pre-installed?
