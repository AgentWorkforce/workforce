# AgentWorkforce persona-authoring skills

Skills for use by [AgentWorkforce](https://github.com/AgentWorkforce/workforce) persona authors. These cover the three persona spec fields whose failure modes are silent or non-obvious:

- **[`@agent-workforce/persona-relayfile-mount`](./persona-relayfile-mount/SKILL.md)** — when to declare `mount`, the gitignore allow-list idiom (with the non-obvious `!web` vs `!web/` walker gotcha), `readonlyPatterns` scope rules, and the `.git` sandbox behavior.
- **[`@agent-workforce/persona-mcp-servers`](./persona-mcp-servers/SKILL.md)** — `mcpServers` spec shape (http/sse vs stdio), `$VAR` secret substitution, harness support matrix that constrains harness selection (`opencode` silently drops MCP), and `permissions.allow` pairing.
- **[`@agent-workforce/persona-sidecars`](./persona-sidecars/SKILL.md)** — the silent-footgun path-vs-inline distinction between `claudeMd` / `agentsMd` (path) and `claudeMdContent` / `agentsMdContent` (inline) that the dry-run validator does NOT catch.

## When to install

These skills are useful when:

- Authoring a new persona JSON for the AgentWorkforce CLI by hand
- Improving an existing persona's `mount`, `mcpServers`, or sidecar configuration
- Debugging why a persona's mount appears empty, MCP server isn't responding, or CLAUDE.md / AGENTS.md is missing at session start

The built-in `persona-maker` persona declares them in its `skills[]` so they materialize automatically when you run `agentworkforce agent persona-maker`.

## Install

```bash
# Single skill
prpm install @agent-workforce/persona-relayfile-mount

# All three
prpm install @agent-workforce/persona-relayfile-mount \
            @agent-workforce/persona-mcp-servers \
            @agent-workforce/persona-sidecars
```

## License

MIT. See [LICENSE](./LICENSE).
