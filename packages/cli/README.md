# agent-workforce CLI

A thin command-line front end for the workload-router. Spawns the harness CLI
(`claude`, `codex`, `opencode`) configured by a selected **persona** — either a
built-in one from `/personas/`, or a user-local one that extends a built-in.

```
agent-workforce agent <persona>[@<tier>] [task...]
```

- No `task` → drops you into an interactive session with the harness.
- `task...` given → runs one-shot (via `usePersona().sendMessage()`) and streams
  output to stdout/stderr.

## Install

The CLI ships as a `bin` in `@agentworkforce/workload-router`. From the repo
checkout:

```sh
corepack pnpm -r build
corepack pnpm --filter @agentworkforce/workload-router link --global
```

That puts `agent-workforce` on your PATH.

## Selectors

```
agent-workforce agent <persona>[@<tier>] [task...]
```

- `<persona>` — matches, in order:
  1. A **pwd-local** id (files in `<cwd>/.agent-workforce/*.json`)
  2. A **home-local** id (files in `~/.agent-workforce/*.json`)
  3. A **library** persona — by intent first (e.g. `review`), then by id
     (e.g. `code-reviewer`)
- `<tier>` — `best` | `best-value` | `minimum`. Defaults to `best-value`.

Unknown persona prints the full catalog with each entry's origin.

### Examples

```sh
# One-shot against the built-in code reviewer
agent-workforce agent review@best-value "look at the diff on this branch"

# Interactive PostHog session (library persona, needs POSTHOG_API_KEY)
agent-workforce agent posthog@best

# Interactive against a local override
agent-workforce agent my-posthog@best
```

## Personas

A persona is a JSON object describing *what harness runs, which model, with
what system prompt, what skills to install, what env vars to inject, and which
MCP servers to attach*. Full library shape:

```jsonc
{
  "id": "posthog",
  "intent": "posthog",
  "description": "…",
  "skills": [],
  "env": { "POSTHOG_API_KEY": "$POSTHOG_API_KEY" },
  "mcpServers": {
    "posthog": {
      "type": "http",
      "url": "https://mcp.posthog.com/mcp",
      "headers": { "Authorization": "Bearer $POSTHOG_API_KEY" }
    }
  },
  "tiers": {
    "best":       { "harness": "claude", "model": "claude-opus-4-6",            "systemPrompt": "…", "harnessSettings": { "reasoning": "high",   "timeoutSeconds": 900 } },
    "best-value": { "harness": "claude", "model": "claude-sonnet-4-6",          "systemPrompt": "…", "harnessSettings": { "reasoning": "medium", "timeoutSeconds": 600 } },
    "minimum":    { "harness": "claude", "model": "claude-haiku-4-5-20251001", "systemPrompt": "…", "harnessSettings": { "reasoning": "low",    "timeoutSeconds": 300 } }
  }
}
```

See `/personas/*.json` for all built-ins.

## Local personas & the cascade

Local persona files layer on top of the library. Resolution precedence (highest
wins):

1. `<cwd>/.agent-workforce/*.json` — **pwd**
2. `~/.agent-workforce/*.json` — **home** (override path via
   `AGENT_WORKFORCE_CONFIG_DIR`)
3. Built-in personas in `/personas/` — **library**

Local files are **partial overlays**: only the fields you set replace the
inherited value. Everything else cascades through from below.

### Minimal override: add your API key

`~/.agent-workforce/my-posthog.json`:

```json
{
  "id": "my-posthog",
  "extends": "posthog",
  "env": { "POSTHOG_API_KEY": "$POSTHOG_API_KEY" }
}
```

That inherits every field from the library `posthog` persona, then layers your
`env` on top. `agent-workforce agent my-posthog@best` now works as long as
`POSTHOG_API_KEY` is exported in your shell.

### Same-id override (implicit extends)

If your file's `id` matches a persona in a lower layer and you omit `extends`,
the loader implicitly inherits from that same-id base:

`<cwd>/.agent-workforce/posthog.json`:

```json
{
  "id": "posthog",
  "env": { "POSTHOG_API_KEY": "$POSTHOG_API_KEY" }
}
```

Resolving `posthog` now hits this pwd override first; it inherits the rest
(MCP, tiers, description, etc.) from the library `posthog`.

### Cascade chain

A pwd file can extend a home file, which extends the library:

```
~/.agent-workforce/ph-base.json:
{ "id": "ph-base", "extends": "posthog", "env": { "POSTHOG_ORG": "acme" } }

<cwd>/.agent-workforce/ph-prod.json:
{ "id": "ph-prod", "extends": "ph-base", "env": { "POSTHOG_API_KEY": "$PROD_KEY" } }
```

Resolving `ph-prod`:

- Start with library `posthog` (MCP, tiers, prompt, …)
- Layer home `ph-base` on top (adds `POSTHOG_ORG=acme`)
- Layer pwd `ph-prod` on top (adds `POSTHOG_API_KEY`)

`extends` is resolved **strictly against lower layers** — pwd extends home or
library, home extends library, library has no `extends`.

### Override shape (all fields except `id` optional)

```jsonc
{
  "id": "my-agent",            // required
  "extends": "posthog",        // optional; implicit same-id if omitted
  "description": "…",          // replaces base description
  "skills": [ … ],             // replaces entire skills array
  "env": { … },                // union, local wins per key
  "mcpServers": { … },         // union by server name, local wins per key
  "permissions": {             // allow/deny union (dedup), mode replaces
    "allow": ["…"], "deny": ["…"], "mode": "default"
  },
  "systemPrompt": "…",         // replaces systemPrompt on every inherited tier
  "tiers": {                   // per-tier partial override
    "best": { "model": "claude-sonnet-4-6" }
    // other tiers inherited untouched
  }
}
```

**Per-tier partial merge.** If you set `tiers.best.model`, only `model`
changes — `systemPrompt`, `harness`, and `harnessSettings` still come from the
base. Use top-level `systemPrompt` if you want to replace the prompt
uniformly across all tiers.

## Env references & secrets

Any `env` value or `mcpServers.*.{headers,env,args,url,command}` value can be
either a literal string or an env reference. Two forms:

| Form | Meaning | Example |
| ---- | ------- | ------- |
| `"$VAR"`          | Whole-string reference — the entire value is the env var.        | `"POSTHOG_API_KEY": "$POSTHOG_API_KEY"` |
| `"prefix ${VAR}"` | Braced interpolation — each `${VAR}` is replaced in place, anywhere in the string. | `"Authorization": "Bearer ${POSTHOG_API_KEY}"` |

- Both forms resolve against the shell `process.env` at **spawn time** (not
  load time).
- **Unbraced `$VAR` mid-string stays literal** — `"prefix-$FOO"` is NOT
  interpolated. Use `${FOO}` if you want interpolation there. This prevents a
  stray `$` in a JSON string from accidentally getting eaten.
- An unset or empty referenced var is a **warning, not a fatal error**. The
  CLI drops the referring entry and proceeds. So a persona that references
  `$POSTHOG_API_KEY` in both `env` and an `Authorization` header will, if the
  var isn't set, launch without either — and the agent can still authenticate
  interactively (e.g. via Claude Code's MCP OAuth flow). Example warning:

  ```
  warning: env.POSTHOG_API_KEY dropped (env var POSTHOG_API_KEY is not set).
  warning: mcpServers.posthog.headers.Authorization dropped (env var POSTHOG_API_KEY is not set).
          (referenced env vars were not set — proceeding without those values;
          if the agent relies on them it may need to authenticate
          interactively, e.g. via OAuth.)
  ```

- An MCP server whose **structural** field (`url`, `command`, or any `arg`)
  references a missing var is dropped entirely, since the server couldn't be
  launched without that value. The warning names the server and the refs that
  were unset.

Secrets therefore stay in your shell/keychain, not in files on disk — local
persona JSON remains commit-safe as long as you only use references.

## Permissions

A persona can declare which tool calls the harness should auto-approve, block,
or gate via a permission mode. Skip the approval prompts for trusted tools
(e.g. a persona's own MCP server); keep them on for anything you want to
eyeball.

```jsonc
{
  "permissions": {
    "allow": ["mcp__posthog", "Bash(git *)"],  // auto-approve
    "deny":  ["Bash(rm -rf *)"],                // always block
    "mode":  "default"                          // default | acceptEdits | bypassPermissions | plan
  }
}
```

- **Tool patterns** are passed through verbatim; use the harness's native
  grammar. For Claude Code: `Bash(<pattern>)`, `Edit(<glob>)`,
  `mcp__<server>` (all tools from that server), `mcp__<server>__<tool>`
  (specific tool).
- **Harness support today:** only `claude` is wired (flags: `--allowedTools`,
  `--disallowedTools`, `--permission-mode`). codex and opencode emit a
  warning and fall back to their defaults when `permissions` is set.
- **Cascade merge:** `allow` and `deny` are unions across layers (deduped on
  merge); `mode` is replaced by the topmost layer that sets it. So the
  library can declare the minimum-viable allow list, home can layer on
  project-wide denies, and pwd can add per-project patterns — they all
  compose.

### Example: PostHog with auto-approve

The built-in `posthog` persona declares `permissions.allow = ["mcp__posthog"]`
so that once you've authenticated (either by passing `POSTHOG_API_KEY` up
front or via Claude's OAuth flow), subsequent analytics tool calls don't
prompt. To narrow the auto-approval to read-only tools, override in a local
persona:

```json
{
  "id": "my-posthog",
  "extends": "posthog",
  "permissions": {
    "allow": [
      "mcp__posthog__projects-get",
      "mcp__posthog__insights-list",
      "mcp__posthog__events-query"
    ]
  }
}
```

Because `allow` is a union, the base's `"mcp__posthog"` would still be in the
merged list. If you want to *shrink* the allow list in a local override,
include a comment explaining why — there's currently no "replace" knob, only
union. (File an issue if you need one.)

## MCP servers

The `mcpServers` block mirrors Claude Code's `--mcp-config` JSON shape
verbatim. Three transport types:

```jsonc
// Remote HTTP / streamable-http
{ "type": "http", "url": "https://…", "headers": { "Authorization": "Bearer ${TOKEN}" } }

// Remote SSE (deprecated by most servers but still supported)
{ "type": "sse",  "url": "https://…", "headers": { … } }

// Stdio — long-running local MCP server
{ "type": "stdio", "command": "npx", "args": ["-y", "…"], "env": { "API_KEY": "$API_KEY" } }
```

### Harness support

| Harness  | Interactive MCP | One-shot MCP |
| -------- | --------------- | ------------ |
| claude   | yes (via `--mcp-config` + `--strict-mcp-config`) | not yet — SDK workflow path doesn't thread MCP |
| codex    | not yet — warns and proceeds without MCP | not yet |
| opencode | not yet — warns and proceeds without MCP | not yet |

For a persona that needs MCP today, pick `claude` as the harness on every tier
and use interactive mode.

### MCP isolation

For the `claude` harness the CLI always spawns with `--strict-mcp-config`,
paired with an explicit `--mcp-config` payload (the persona's `mcpServers`, or
`{"mcpServers":{}}` if none). That means **only the servers declared on the
persona are loaded** — your user-level `~/.claude.json` MCPs and any
project-level MCP sources are ignored inside the session. This keeps each
persona session self-contained and prevents cross-contamination with the
agents you normally run. If you need one of your personal MCPs inside a
persona session, add it to the persona's `mcpServers` block.

## Interactive vs one-shot

### Interactive

```sh
agent-workforce agent <persona>[@<tier>]
```

1. Resolves the persona, walks the cascade, resolves `$VAR` refs.
2. Runs skill install (`prpm install …`) if the persona declares any skills.
3. Execs the harness binary with stdio inherited:
   - `claude`: `claude --model <model> --append-system-prompt <prompt>
     --mcp-config '<json>' --strict-mcp-config`. Both flags are always passed
     so the session only sees the persona's declared MCP servers — see
     **MCP isolation** above.
   - `codex`: `codex -m <model>` with the system prompt as the initial
     positional `[PROMPT]`. (codex has no `--system-prompt` flag today.)
   - `opencode`: `opencode --model <model>` with the system prompt as the
     initial argument.
4. Runs the skill cleanup command on exit, regardless of exit status.
5. Propagates the harness's exit code.

Signals (SIGINT, SIGTERM) are forwarded to the child.

### One-shot

```sh
agent-workforce agent <persona>[@<tier>] "<task…>"
```

Non-interactive. Delegates to `usePersona(intent, { tier }).sendMessage(task)`
from the workload-router SDK, which spawns an ad-hoc single-step workflow:
install skills → run agent → cleanup. Stdout/stderr stream live; exit code
matches the agent's.

Env from the persona is passed through via `ExecuteOptions.env`. `mcpServers`
is currently **ignored with a warning** in one-shot mode — the SDK workflow
path doesn't thread MCP config yet.

## Selecting a harness per tier

A persona's three tiers can use different harnesses. The built-in
`npm-provenance-publisher` has `best` on codex and `best-value` on opencode,
for example.

If a persona uses MCP, keep every tier on `claude` — only the claude harness
wires MCP at spawn time today.

## Troubleshooting

- **`Unknown persona "X".`** — The CLI prints the full catalog. If your local
  file should be listed, check for a warning on the preceding line — parse
  errors and bad `extends` references are reported but non-fatal.

- **`warning: <field> dropped (env var X is not set)`** — Informational. The
  CLI skipped that value and is launching without it. Export the variable if
  you want the agent to have it up-front; otherwise the harness may handle
  auth interactively (e.g. Claude Code's MCP OAuth flow).

- **`Failed to spawn "claude": binary not found on PATH.`** — Install the
  harness CLI (`claude`, `codex`, or `opencode`) and ensure it's on your PATH.

- **`warning: persona declares mcpServers but the codex harness is not yet
  wired …`** — Either switch the tier's `harness` to `claude`, or drop the MCP
  requirement.

- **`extends cycle detected through …`** — A local persona extends itself
  transitively. Break the chain or point one link at the library directly.

- **Local file silently missing from the list** — Scroll up for a
  `warning: [layer] file.json: …` line. Common causes: invalid JSON, `id`
  missing, or `extends` pointing at something that isn't in a lower layer.
