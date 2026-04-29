# agent-workforce CLI

A thin command-line front end for the workload-router. Spawns the harness CLI
(`claude`, `codex`, `opencode`) configured by a selected **persona** — either a
built-in one from `/personas/`, or a user-local one that extends a built-in.

```
agent-workforce agent <persona>[@<tier>] [task...]
agent-workforce list [flags]
agent-workforce harness check
```

- `agent` — no `task` drops you into an interactive session with the harness;
  a `task...` argument runs one-shot (via `usePersona().sendMessage()`) and
  streams output to stdout/stderr.
- `list` — print the persona catalog as a table (or JSON). See
  [`## List`](#list) below for every flag.
- `harness check` — probe which harnesses (`claude`, `codex`, `opencode`)
  are installed. See [`## Harness check`](#harness-check) below.

## Install

The CLI ships under two npm names that point at the same code:

- **`@agentworkforce/cli`** — the scoped package; installs the
  `agent-workforce` bin.
- **`agentworkforce`** — a thin top-level wrapper; installs the
  `agentworkforce` bin so the global install command and command name match
  (`npm i -g agentworkforce`).

Both depend on `@agentworkforce/workload-router` and `@agentworkforce/harness-kit`
via the pnpm workspace. The CLI derives its help-text bin name from
`process.argv[1]`, so `--help` shows whichever name you invoked.

From npm:

```sh
npm i -g agentworkforce      # provides `agentworkforce`
# or
npm i -g @agentworkforce/cli # provides `agent-workforce`
```

From the repo checkout:

```sh
corepack pnpm -r build
corepack pnpm --filter @agentworkforce/cli link --global
```

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

## List

```
agent-workforce list [flags]
```

Prints the merged persona catalog — everything the `agent` subcommand would
accept as a selector — including cascade source (`library`, `home`, `pwd`),
harness, model, description, and tier ("rating"). One row per persona-tier
combination; by default only the **recommended tier per intent** is shown
(as declared in
`packages/workload-router/routing-profiles/default.json`).

### Flags

| Flag | Default | Effect |
| --- | --- | --- |
| `--all` | off | Show every tier of every persona. Alias: `--no-recommended`. |
| `--recommended` | on | Only show the recommended tier per intent. Implicit default; mostly useful for undoing `--all` earlier in a wrapper script. |
| `--filter-rating <tier>` | — | Restrict to a single tier (`best` \| `best-value` \| `minimum`). **Implicitly turns off the recommended-only default**, so filtering by `best` shows every persona's `best` row even when that's not the recommended tier. |
| `--filter-harness <harness>` | — | Restrict to a single harness (`claude` \| `codex` \| `opencode`). Composable with `--filter-rating` and `--all`. |
| `--no-display-description` | off | Hide the `DESCRIPTION` column. `--display-description` re-enables it. |
| `--json` | off | Emit `{ "personas": [...] }` with one object per row. Same field set as the table, useful for scripting. |
| `-h`, `--help` | — | Print a one-line usage string and exit. |

Invalid values for `--filter-rating` / `--filter-harness` fail fast and list
the allowed values.

### Examples

```sh
# Default: one row per persona, recommended tier only
agent-workforce list

# See every tier
agent-workforce list --all

# Only the top tier across the catalog — independent of recommendations
agent-workforce list --filter-rating best

# All claude-harness personas (any tier)
agent-workforce list --all --filter-harness claude

# Compact table for a narrow terminal
agent-workforce list --no-display-description

# Machine-readable
agent-workforce list --json --filter-harness claude
```

## Harness check

```
agent-workforce harness check
```

Probes your PATH for each supported harness binary (`claude`, `codex`,
`opencode`) and prints a table with status (`ok` / `missing`), resolved
version, and the resolved path (or the error, for missing ones). Exit
code is always `0` — this command is diagnostic, not a gate.

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
      "headers": { "Authorization": "Bearer ${POSTHOG_API_KEY}" }
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
agent-workforce agent [--install-in-repo] [--clean] <persona>[@<tier>]
```

`--install-in-repo` and `--clean` are mutually exclusive — see
[**Clean mode**](#clean-mode) below.

1. Resolves the persona, walks the cascade, resolves `$VAR` refs.
2. **Stages skills outside the repo by default** (claude interactive only —
   see **Skill staging** below). For codex / opencode, or when
   `--install-in-repo` is passed, falls back to the legacy repo-relative
   install path (`.claude/skills/`, `.agents/skills/`, `.skills/`).
3. Runs skill install (`prpm install …`) if the persona declares any skills,
   using the computed target (stage dir or repo).
4. Execs the harness binary with stdio inherited:
   - `claude`: `claude --model <model> --append-system-prompt <prompt>
     --mcp-config '<json>' --strict-mcp-config [--plugin-dir <stage>]`. The
     `--plugin-dir` flag is appended when the session uses out-of-repo
     staging so Claude Code loads exactly the staged skills — and nothing
     the repo happens to carry. Both MCP flags are always passed so the
     session only sees the persona's declared MCP servers (see **MCP
     isolation** above).
   - `codex`: `codex -m <model>` with the system prompt as the initial
     positional `[PROMPT]`. (codex has no `--system-prompt` flag today.)
   - `opencode`: `opencode --model <model>` with the system prompt as the
     initial argument.
5. Runs the skill cleanup command on exit, regardless of exit status. In
   stage-dir mode this is a single `rm -rf <stage-dir>`.
6. Propagates the harness's exit code.

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

One-shot mode still installs into the repo regardless of `--install-in-repo`;
out-of-repo staging only applies to the interactive path today because the
agent-relay workflow SDK doesn't yet thread `--plugin-dir` into the claude
agent adapter. `--install-in-repo` passed to a one-shot run prints a `note:`
and is a no-op.

## Skill staging

By default, interactive `claude` sessions stage skills under the user's home
directory instead of the current repo. Nothing gets written to `.claude/` in
the working tree, and the session only sees the skills the persona declares
— never whatever skills the repo happens to carry on disk.

**Layout:**

```
~/.agent-workforce/
└── sessions/<personaId>-<timestamp>-<rand>/
    └── claude/
        └── plugin/                                ← passed as --plugin-dir
            ├── .claude-plugin/plugin.json         ← generated scaffold
            ├── skills → .claude/skills            ← relative symlink
            └── .claude/skills/<name>/SKILL.md     ← prpm install output
```

- **Stage dir** — `~/.agent-workforce/sessions/<id>/claude/plugin/`.
  `<id>` is `<personaId>-<base36-timestamp>-<hex-random>` so parallel
  sessions never collide.
- **Plugin wrapper** — the CLI writes a minimal `.claude-plugin/plugin.json`
  (`{"name":"agent-workforce-session","version":"0.0.0",…}`) and a relative
  symlink `skills → .claude/skills` so Claude Code's plugin layout
  (`skills/<name>/SKILL.md`) resolves to prpm's actual output
  (`.claude/skills/<name>/SKILL.md`) without moving any files.
- **prpm install** — still runs `npx -y prpm install <ref> --as claude`,
  but inside `cd <stage-dir>` so the harness-conventional `.claude/skills/`
  lands in the stage dir, not the repo.
- **Cleanup** — on exit, two cleanup scopes run. The workload-router removes
  `<stage-dir>` (e.g. `.../sessions/<id>/claude/plugin/`) via its generated
  `rm -rf` command. The CLI additionally removes the enclosing session root
  (`.../sessions/<id>/`) so the mount dir and any empty parents don't
  accumulate under `~/.agent-workforce/sessions/`. The provider lockfile
  (`prpm.lock`) is inside the stage dir and goes with it — no repeat-run
  resolution cache today. Restart cost is one prpm install per session.

**Opt-out — `--install-in-repo`:**

Pass `--install-in-repo` to fall back to the legacy behavior (skills land in
the repo's `.claude/skills/` directory, cleaned on exit):

```sh
agent-workforce agent --install-in-repo code-reviewer@best
```

Useful when you want to inspect the installed skills on disk, or when the
stage dir conflicts with something else (network filesystem, read-only
`$HOME`, etc.).

**Caveats for V1:**

- **Claude harness only.** codex and opencode continue to install into their
  conventional repo-relative directories. The SDK throws if `installRoot` is
  passed with a non-claude harness.
- **No cache layer yet.** Every interactive session runs a fresh prpm install
  into a new stage dir. A `~/.agent-workforce/cache/` content-addressed cache
  is planned but not wired up.
- **One-shot path unchanged.** See the paragraph under "One-shot" above.

## Clean mode

`--clean` launches an interactive claude session inside a
[`@relayfile/local-mount`](https://www.npmjs.com/package/@relayfile/local-mount)
symlink mount that hides the repo's Claude Code configuration from the
session — so the model sees persona context + user-level context, and
nothing the repo itself declares.

```sh
agent-workforce agent --clean <persona>[@<tier>]
```

**What's hidden (gitignore semantics, at any depth):**

| Pattern | Rationale |
| --- | --- |
| `CLAUDE.md` | Repo-level project memory |
| `CLAUDE.local.md` | Developer-local project memory |
| `.claude` | Repo Claude Code config dir (settings, agents, skills, commands) |
| `.mcp.json` | Repo-declared MCP servers |

**What's preserved:**

- **User-level context** under `~/.claude/` — `CLAUDE.md`, skills, etc.
  still load. `--clean` scrubs the *project*, not the user. To exclude
  user-level context too, launch under a scratch `$HOME`.
- **Persona skills.** The `--plugin-dir` passed to claude resolves to an
  absolute path *outside* the mount, so staged skills from
  `~/.agent-workforce/sessions/<id>/claude/plugin/` load normally.
- **Keychain auth.** `--clean` does NOT pass `--bare`; it only hides
  files via the mount. Claude Code's macOS keychain login stays active.
- **Persona `mcpServers`.** Still passed via `--mcp-config` — unaffected
  by the mount. The repo's `.mcp.json` is hidden regardless.

### Session layout

Both the skill install root and the sandbox mount live under a single
session directory. The session id (`<personaId>-<base36-timestamp>-<hex>`)
is generated once and both paths are derived from it:

```
~/.agent-workforce/
└── sessions/<personaId>-<timestamp>-<rand>/
    ├── claude/
    │   └── plugin/                                ← passed as --plugin-dir
    │       ├── .claude-plugin/plugin.json
    │       ├── skills → .claude/skills
    │       └── .claude/skills/<name>/SKILL.md
    └── mount/                                     ← --clean: claude's cwd
        └── <mirrored project tree, minus the hidden patterns>
```

`@relayfile/local-mount` handles mount creation, process spawn,
SIGINT/SIGTERM forwarding, write syncback, and cleanup on exit. The
agent-workforce CLI just wires the paths and passes the persona's argv.

### Interactions with other flags

- **`--clean` + `--install-in-repo` is rejected** — they ask for
  incompatible things. `--install-in-repo` stages skills into the real
  repo's `.claude/skills/`; `--clean` hides the real repo. Pick one.
- **`--clean` on codex/opencode is a warning no-op.** Only the claude
  harness gets the mount (it's the only one whose native surface includes
  the hidden patterns).
- **`--clean` on a one-shot run is a warning no-op.** The agent-relay
  workflow SDK doesn't thread mount integration today; matches how
  `--install-in-repo` behaves in one-shot mode.

### Example

```sh
# Interactive PostHog session with the repo's CLAUDE.md, .claude/, and
# .mcp.json hidden — session sees the persona's staged skills plus your
# user-level ~/.claude/CLAUDE.md, nothing else from this repo.
export POSTHOG_API_KEY=phx_…
agent-workforce agent --clean posthog@best
```

On exit: mount is synced back to the real repo, then torn down; skill
stage dir is cleaned up by the existing `rm -rf` cleanup command.

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
