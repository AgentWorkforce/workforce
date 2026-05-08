# agentworkforce CLI

A thin command-line front end for the workload-router. Spawns the harness CLI
(`claude`, `codex`, `opencode`) configured by a selected **persona** from the
project-local layer, configured source directories, or the small internal
built-in system catalog.

```
agentworkforce create [--save-in-directory=<target>] [--save-default] [--install-in-repo] [--no-launch-metadata]
agentworkforce agent [--install-in-repo] [--no-launch-metadata] <persona>[@<tier>]
agentworkforce list [flags]
agentworkforce show <persona>[@<tier>]
agentworkforce install [flags] <pkg|path>
agentworkforce sources <list|add|remove>
agentworkforce harness check
agentworkforce --version
```

- `create` — opens `persona-maker@best` for creating a new persona.
  It resolves a target persona directory with the same source-cascade
  constructs used by `list`, `show`, and `agent`, then passes `TARGET_DIR` and
  `CREATE_MODE` into the persona as prompt-visible inputs.
- `agent` — drops you into an interactive session with the harness.
- `list` — print the persona catalog as a table (or JSON). See
  [`## List`](#list) below for every flag.
- `show` — print the resolved spec for one persona.
- `install` — copy persona JSON files from an npm or local persona pack into
  the current project's fixed cwd source directory.
- `sources` — list, add, or remove persona source directories.
- `harness check` — probe which harnesses (`claude`, `codex`, `opencode`)
  are installed. See [`## Harness check`](#harness-check) below.
- `--version` — print the installed package version.

## Install

Install the top-level `agentworkforce` package. It provides the
`agentworkforce` bin and depends on this internal CLI package.

From npm:

```sh
npm i -g agentworkforce
```

From the repo checkout:

```sh
corepack pnpm -r build
corepack pnpm --filter agentworkforce link --global
```

## Selectors

```
agentworkforce agent <persona>[@<tier>]
```

- `<persona>` — matches, in order:
  1. A **cwd-local** id (files in `<cwd>/.agentworkforce/workforce/personas/*.json`)
  2. A configured persona source dir, in order. The default is
     `~/.agentworkforce/workforce/personas/*.json`.
  3. An internal **library** persona — by intent first, then by id. The built-in
     library is system-only; optional personas such as `code-reviewer` come from
     installed persona packs.
- `<tier>` — `best` | `best-value` | `minimum`. Defaults to `best-value`.

Unknown persona prints the full catalog with each entry's origin.

## Create

```
agentworkforce create [--save-in-directory=<target>] [--save-default] [--install-in-repo] [--no-launch-metadata]
```

`create` is the persona-authoring entry point. It runs `persona-maker@best`
through the same interactive launch path as `agent`, including skill
materialization, sandbox mount behavior, env/MCP resolution, and harness argv
translation. The only extra work `create` does is resolve a target and pass it as
persona inputs:

| Input | Meaning |
| --- | --- |
| `TARGET_DIR` | Absolute directory where the new `<id>.json` persona file should be written. |
| `CREATE_MODE` | `local` writes only JSON; `built-in` is reserved for internal/system personas and also updates catalog/routing/test/docs integration. |

Targets:

| Target | Resolves to | Create mode |
| --- | --- | --- |
| `cwd` | `<cwd>/.agentworkforce/workforce/personas` | `local` |
| `user` | `~/.agentworkforce/workforce/personas` (or `AGENT_WORKFORCE_CONFIG_DIR`) | `local` |
| `dir:n` | the nth configured persona source from `sources list` | `local` |
| `library` | `<repo>/personas` | `built-in` |
| path | explicit directory path | `local` |

Default target resolution:

1. `--save-in-directory=<target>` wins.
2. Else use `defaultCreateTarget` from `~/.agentworkforce/workforce/config.json`.
3. Else use `cwd` (`<cwd>/.agentworkforce/workforce/personas`).

The cwd persona directory is created (`mkdir -p`) when it does not exist, so a
fresh project can run `agentworkforce create` without any setup. To author
personas anywhere else, pass `--save-in-directory=<target>` on the command line
(the value can also be passed as `--save-in-directory <target>`), or use
`--save-default` once to persist a different default in the source config.

Examples:

```sh
# Create in <cwd>/.agentworkforce/workforce/personas (created if missing)
agentworkforce create

# Force the user persona directory
agentworkforce create --save-in-directory=user

# Create in a configured persona source
agentworkforce create --save-in-directory=dir:1

# Create in an explicit checked-out persona directory and make that the default
agentworkforce create --save-in-directory=../team-personas/personas --save-default

# Create an internal/system built-in persona in this repo's /personas catalog
agentworkforce create --save-in-directory=library
```

### Examples

```sh
agentworkforce create

# Interactive code reviewer
agentworkforce install @agentworkforce/personas-core --persona code-reviewer
agentworkforce agent code-reviewer@best-value

# Interactive against a local override
agentworkforce agent my-reviewer@best
```

## Install persona packs

```text
agentworkforce install <pkg|path> [--persona <id> ...] [--overwrite]
```

`install` is a shadcn-style copy utility for persona JSON. It copies persona
files into the current project's fixed cwd layer:
`<cwd>/.agentworkforce/workforce/personas/`.

Once copied, files are project-owned. Edit them directly and commit them to
git. The CLI does not create an install ledger, lockfile, manifest, update
command, uninstall command, diff command, or central AgentWorkforce registry.

### Package and path forms

Npm package specs are resolved with `npm pack`, so npm auth, npm config,
private packages, tags, and versions work the same way they do for npm:

```sh
agentworkforce install @agentworkforce/personas-core
agentworkforce install @agentworkforce/personas-core@0.8.0 --persona code-reviewer
agentworkforce install @agentrelay/personas
agentworkforce install @agentrelay/personas@1.2.3
agentworkforce install @agentrelay/personas@latest
```

Local path installs read directly from the directory:

```sh
agentworkforce install ./local-personas
agentworkforce install /absolute/path/to/local-personas
```

### Selecting personas

By default, every `*.json` file in the pack's persona directory is copied.
Use repeated `--persona <id>` flags to install a subset by persona `id`:

```sh
agentworkforce install @agentworkforce/personas-core --persona code-reviewer
agentworkforce install @agentrelay/personas --persona relay-orchestrator
```

If any requested id is missing, the command exits non-zero before copying
anything.

### Conflicts and overwrite

Target filenames are flattened into the cwd persona directory:

```text
package/personas/nested/code-reviewer.json
  -> .agentworkforce/workforce/personas/code-reviewer.json
```

If the target file already exists, the installer reports a conflict, skips
that file, and exits non-zero. Non-conflicting files from the same run may
still be copied. Pass `--overwrite` to replace existing files unconditionally:

```sh
agentworkforce install @agentrelay/personas --overwrite
```

Filename collisions across packages use the same rule. The install layer does
not namespace files by package; avoid shipping two pack files with the same
basename if they are expected to be installed together.

### Persona pack format

A pack can contain multiple personas:

```text
@acme/personas
├── package.json
└── personas/
    ├── reviewer.json
    └── release-runner.json
```

`package.json` may declare the persona directory:

```json
{
  "name": "@acme/personas",
  "version": "1.2.3",
  "files": ["personas"],
  "keywords": ["agentworkforce-personas"],
  "agentworkforce": {
    "personas": "personas"
  }
}
```

Resolution rules:

1. Read `package.json.agentworkforce.personas` if present.
2. Otherwise use a top-level `personas/` directory.
3. Recursively copy every `*.json` file from that directory, flattening to
   `<cwd>/.agentworkforce/workforce/personas/<basename>.json`.

Local path installs use the same metadata rules.

### Relationship to sources

Use `install` when this project should receive editable copies:

```sh
agentworkforce install @acme/personas
git add .agentworkforce/workforce/personas
```

Use `sources add` when you want the cascade to point at a live directory
without copying:

```sh
agentworkforce sources add ~/src/acme-personas/personas
```

Both feed the same cascade. `install` writes to the fixed cwd layer, while
`sources` changes the configured source directories in
`~/.agentworkforce/workforce/config.json`.

### Author and publish a persona pack

```sh
mkdir -p acme-personas/personas
cd acme-personas
npm init -y
npm pkg set name=@acme/personas version=1.0.0
npm pkg set 'files[0]=personas' 'keywords[0]=agentworkforce-personas'
npm pkg set agentworkforce.personas=personas
$EDITOR personas/reviewer.json
npm publish --access public
```

Then install it in a project:

```sh
cd ../my-project
agentworkforce install @acme/personas --persona reviewer
agentworkforce list --filter-tag review
agentworkforce agent reviewer@best-value
```

## List

```
agentworkforce list [flags]
```

Prints the merged persona catalog — everything the `agent` subcommand would
accept as a selector — including cascade source (`library`, `user`, `cwd`,
or `dir:<n>`),
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
agentworkforce list

# See every tier
agentworkforce list --all

# Only the top tier across the catalog — independent of recommendations
agentworkforce list --filter-rating best

# All claude-harness personas (any tier)
agentworkforce list --all --filter-harness claude

# Compact table for a narrow terminal
agentworkforce list --no-display-description

# Machine-readable
agentworkforce list --json --filter-harness claude
```

## Sources

```
agentworkforce sources list [--json]
agentworkforce sources add <dir> [--position <n>]
agentworkforce sources remove <dir|config-position>
```

The fixed project source is always first:
`<cwd>/.agentworkforce/workforce/personas/*.json`.

After that, the CLI reads an ordered list of configurable persona directories
from `~/.agentworkforce/workforce/config.json`. If no config exists, the list
defaults to `~/.agentworkforce/workforce/personas`. This makes installed
personas work as plain JSON files in the default user location, or from any
checked-out repo you add as a source directory.

The same config may also carry `defaultCreateTarget`, used by `agentworkforce create`
to override its default of `cwd`:

```json
{
  "personaDirs": ["~/src/company-personas/personas"],
  "defaultCreateTarget": "dir:1"
}
```

Valid `defaultCreateTarget` values are the same values accepted by
`create --save-in-directory=<target>`: `cwd`, `user`, `dir:n`, `library`, or an
explicit path. When this key is unset, `agentworkforce create` writes to
`<cwd>/.agentworkforce/workforce/personas` (creating it if missing). Use
`agentworkforce create --save-in-directory=<target> --save-default` to write
the override without editing JSON by hand.

`sources add` appends by default. `--position <n>` inserts at the 1-based
position among configurable directories, so `--position 1` gives that directory
the highest priority after the fixed cwd source. `sources remove` accepts either
that configurable position or an exact path.

Examples:

```sh
# Show the full source cascade, including fixed cwd and library entries
agentworkforce sources list

# Install personas from another checkout, below the default user persona dir
agentworkforce sources add ~/src/company-personas/personas

# Give a checked-out persona repo priority over the default user dir
agentworkforce sources add ~/src/company-personas/personas --position 1

# Remove the first configurable persona source
agentworkforce sources remove 1
```

## Harness check

```
agentworkforce harness check
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

The repo built-in catalog is intentionally system-only and currently contains
`persona-maker`. Optional reusable personas are installed from packs such as
`@agentworkforce/personas-core` or `@agentrelay/personas`.

## Local personas & the cascade

Local persona files layer on top of the library. Resolution precedence (highest
wins):

1. `<cwd>/.agentworkforce/workforce/personas/*.json` — **cwd**
2. Configurable persona source dirs, in order. Default:
   `~/.agentworkforce/workforce/personas/*.json` — **user**
3. Internal built-in system personas in `/personas/` — **library**

Local files are **partial overlays**: only the fields you set replace the
inherited value. Everything else cascades through from below.

Set `AGENT_WORKFORCE_HOME` to move the `~/.agentworkforce/workforce` config
root. The legacy `AGENT_WORKFORCE_CONFIG_DIR` env var is still honored as a
direct override for the default user persona directory.

### Minimal override

Install the core pack first so `code-reviewer` exists in a lower layer:

```sh
agentworkforce install @agentworkforce/personas-core --persona code-reviewer
```

`~/.agentworkforce/workforce/personas/my-reviewer.json`:

```json
{
  "id": "my-reviewer",
  "extends": "code-reviewer",
  "systemPrompt": "Review this repository's API compatibility and migration risks. Lead with blockers."
}
```

That inherits every field from the installed `code-reviewer` persona, then
layers your local prompt on top.

### Same-id override (implicit extends)

If your file's `id` matches a persona in a lower layer and you omit `extends`,
the loader implicitly inherits from that same-id base:

`<cwd>/.agentworkforce/workforce/personas/code-reviewer.json`:

```json
{
  "id": "code-reviewer",
  "systemPrompt": "Review with this repository's compatibility checklist first."
}
```

Resolving `code-reviewer` now hits this cwd override first; it inherits the
rest from the installed lower-layer `code-reviewer`.

### Cascade chain

A cwd file can extend a user or configured-dir file, which can extend an
installed pack persona or the internal library:

```
~/.agentworkforce/workforce/personas/reviewer-base.json:
{ "id": "reviewer-base", "extends": "code-reviewer", "systemPrompt": "Review with org-wide API compatibility rules." }

<cwd>/.agentworkforce/workforce/personas/reviewer-prod.json:
{ "id": "reviewer-prod", "extends": "reviewer-base", "systemPrompt": "Add this service's migration checklist." }
```

Resolving `reviewer-prod`:

- Start with installed `code-reviewer` (tiers, skills, prompt, ...)
- Layer user `reviewer-base` on top
- Layer cwd `reviewer-prod` on top

`extends` is resolved **strictly against lower layers** — cwd extends configured
dirs or library, configured dirs extend lower configured dirs or library, and
library has no `extends`.

### Override shape (all fields except `id` optional)

```jsonc
{
  "id": "my-agent",            // required
  "extends": "code-reviewer",  // optional; implicit same-id if omitted
  "description": "…",          // replaces base description
  "skills": [ … ],             // replaces entire skills array
  "inputs": {                  // prompt-visible runtime inputs; union by key
    "TARGET_DIR": {
      "description": "Where to write output",
      "default": "./out",
      "env": "MY_AGENT_TARGET_DIR"
    }
  },
  "env": { … },                // union, local wins per key
  "mcpServers": { … },         // union by server name, local wins per key
  "mount": {                   // Relayfile file scope; pattern arrays append
    "ignoredPatterns": ["…"],
    "readonlyPatterns": ["…"]
  },
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

To define a standalone local persona that does not inherit from a lower layer,
include `intent` and a complete `tiers` object for `best`, `best-value`, and
`minimum`. This is the shape persona packs usually ship before `install`
copies them into the cwd layer.

## Creating Personas

Personas are plain JSON files. Use `agentworkforce create` when you want the
persona-maker to draft one with the repo's conventions, or write the JSON by
hand when the shape is simple.

### Local persona

Local personas live in the source cascade and do not require built-in catalog
integration:

```sh
agentworkforce create --save-in-directory=user
agentworkforce create --save-in-directory=cwd
agentworkforce create --save-in-directory=dir:1
```

The persona maker receives `TARGET_DIR` and `CREATE_MODE=local`, so it
should write only:

```
<target-dir>/<id>.json
```

Minimal local persona:

```json
{
  "id": "my-reviewer",
  "extends": "code-reviewer",
  "description": "Reviews this project with local conventions.",
  "systemPrompt": "Focus on this repository's API compatibility rules and summarize only blocking issues."
}
```

### Built-in persona

Built-in personas live in the repo's `/personas` catalog, are reserved for
required internal/system surface, and require workload-router integration:

```sh
agentworkforce create --save-in-directory=library
```

The persona maker receives `CREATE_MODE=built-in`, so it should write
`personas/<id>.json`, update the internal catalog registration/routing/tests/docs
as needed, regenerate `src/generated/personas.ts`, and run the repo check.
Optional generic or domain personas should be published through persona packs
instead.

### Full persona file

Use this when you are not extending an existing persona:

```jsonc
{
  "id": "release-checker",
  "intent": "release-check",
  "tags": ["release", "review"],
  "description": "Checks release readiness and reports blockers.",
  "skills": [
    {
      "id": "prpm/npm-trusted-publishing",
      "source": "https://prpm.dev/packages/@prpm/npm-trusted-publishing",
      "description": "Trusted publishing and provenance setup guidance."
    }
  ],
  "inputs": {
    "PACKAGE_NAME": {
      "description": "Package to inspect.",
      "env": "PACKAGE_NAME",
      "default": "."
    }
  },
  "env": {
    "NPM_TOKEN": "$NPM_TOKEN"
  },
  "permissions": {
    "allow": ["Bash(npm *)"],
    "deny": ["Bash(npm publish *)"],
    "mode": "default"
  },
  "mount": {
    "readonlyPatterns": ["*"]
  },
  "tiers": {
    "best": {
      "harness": "codex",
      "model": "openai-codex/gpt-5.3-codex",
      "systemPrompt": "Check release readiness for $PACKAGE_NAME. Produce blockers first, then evidence.",
      "harnessSettings": { "reasoning": "high", "timeoutSeconds": 1200 }
    },
    "best-value": {
      "harness": "opencode",
      "model": "opencode/gpt-5-nano",
      "systemPrompt": "Check release readiness for $PACKAGE_NAME. Produce blockers first, then evidence.",
      "harnessSettings": { "reasoning": "medium", "timeoutSeconds": 900 }
    },
    "minimum": {
      "harness": "opencode",
      "model": "opencode/minimax-m2.5-free",
      "systemPrompt": "Check release readiness for $PACKAGE_NAME. Produce only blocking issues and exact evidence.",
      "harnessSettings": { "reasoning": "low", "timeoutSeconds": 600 }
    }
  }
}
```

### Persona inputs

`inputs` declare non-secret values that a launcher can pass into a persona at
runtime. They are useful for output paths, package names, modes, and other
prompt-visible context that should not be hard-coded into the persona.

Input names must be env-style uppercase keys: `TARGET_DIR`, `PACKAGE_NAME`,
`CREATE_MODE`. In `systemPrompt`, use `$NAME` or `${NAME}`; both forms are
replaced before the harness starts.

```jsonc
{
  "inputs": {
    "TARGET_DIR": {
      "description": "Directory where generated files should be written.",
      "env": "MY_TARGET_DIR",
      "default": "./out"
    },
    "CREATE_MODE": "local"
  },
  "tiers": {
    "best": {
      "systemPrompt": "Write the persona to $TARGET_DIR. Mode: ${CREATE_MODE}."
    }
  }
}
```

Each input may be either a string shorthand or an object:

| Shape | Meaning |
| --- | --- |
| `"NAME": "value"` | Shorthand for `{ "default": "value" }`. |
| `description` | Human-readable explanation for `show`, docs, and catalog UIs. |
| `env` | Env var to read when the caller did not provide an explicit value. Defaults to the input key. |
| `default` | Literal fallback when no explicit value or env var exists. |

Resolution order is strict:

1. Explicit launcher value, such as the values passed by `agentworkforce create`.
2. `process.env[env]`, or `process.env[NAME]` when `env` is omitted.
3. `default`.
4. If none exist, launch fails before the harness starts.

Resolved inputs are substituted into the system prompt and injected into the
child process env under the input key. They are not secrets: resolved values
can appear in prompts, process env, logs, and agent output. Use `env` references
instead for API keys and tokens.

Local persona overlays merge `inputs` by key, so a user or project override can
add one input without replacing all inherited inputs.

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

## Relayfile mount rules

Interactive `claude` and `opencode` sessions run inside a Relayfile mount by
default. File visibility and writability are controlled by the persona's
`mount` block plus project-level dotfiles:

```jsonc
{
  "mount": {
    "ignoredPatterns": ["secrets/**", ".env*"],
    "readonlyPatterns": [
      "*",
      "!docs/",
      "!docs/**"
    ]
  }
}
```

- `ignoredPatterns` are omitted from the mount entirely.
- `readonlyPatterns` are copied into the mount but edits do not sync back.
- Patterns use gitignore semantics, so later `!` negations can reopen paths.
- Persona patterns append to inherited persona patterns. At launch, the CLI
  also merges project-root `.agentignore`, `.agentreadonly`,
  `.<personaId>.agentignore`, and `.<personaId>.agentreadonly`.

## Permissions

A persona can declare which tool calls the harness should auto-approve, block,
or gate via a permission mode. Skip the approval prompts for trusted tools
(e.g. a persona's own MCP server); keep them on for anything you want to
eyeball. File visibility and writability are not defined here; use Relayfile
mount rules (`.agentignore` / `.agentreadonly`) for that.

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
  grammar. For Claude Code: `Bash(<pattern>)`, `mcp__<server>` (all tools
  from that server), `mcp__<server>__<tool>` (specific tool).
- **Harness support today:** only `claude` is wired for `permissions` (flags:
  `--allowedTools`, `--disallowedTools`, `--permission-mode`). codex and
  opencode emit a warning and fall back to their defaults when `permissions`
  is set.
- **Cascade merge:** `allow` and `deny` are unions across layers (deduped on
  merge); `mode` is replaced by the topmost layer that sets it. So the
  library can declare the minimum-viable allow list, a user or configured
  persona source can layer shared denies, and cwd can add per-project patterns
  — they all compose.

## Codex Sandbox Settings

Codex-backed tiers can set Codex launch policy inside `harnessSettings`:

```jsonc
{
  "tiers": {
    "best": {
      "harness": "codex",
      "model": "openai-codex/gpt-5.3-codex",
      "systemPrompt": "…",
      "harnessSettings": {
        "reasoning": "high",
        "timeoutSeconds": 1200,
        "sandboxMode": "workspace-write",
        "approvalPolicy": "on-request",
        "workspaceWriteNetworkAccess": true,
        "webSearch": true
      }
    }
  }
}
```

`sandboxMode` maps to Codex `--sandbox` (`read-only`, `workspace-write`, or
`danger-full-access`), `approvalPolicy` maps to `--ask-for-approval`,
`workspaceWriteNetworkAccess` maps to
`-c sandbox_workspace_write.network_access=<bool>`, and `webSearch` maps to
`--search`. Prefer `workspace-write` plus `workspaceWriteNetworkAccess` for
package or registry discovery so filesystem writes stay sandboxed.

### Example: narrowing inherited auto-approval

If an installed lower-layer persona declares broad permissions, a local override
can add narrower tool patterns for project workflows:

```json
{
  "id": "my-analytics",
  "extends": "analytics-reader",
  "permissions": {
    "allow": [
      "mcp__posthog__projects-get",
      "mcp__posthog__insights-list",
      "mcp__posthog__events-query"
    ]
  }
}
```

Because `allow` is a union, any broad allow pattern from the base persona would
still be in the merged list. If you need to shrink an allow list, create a
standalone local persona or update the lower-layer pack persona; overlays only
append.

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

## Interactive

```sh
agentworkforce agent [--install-in-repo] [--no-launch-metadata] <persona>[@<tier>]
```

By default, claude and opencode sessions run inside a sandbox mount — see
[**Sandbox mount**](#sandbox-mount) below. `--install-in-repo` opts out.

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
6. Records launch metadata for the session and refreshes harness session logs
   while the child runs, then once more after exit. The harness is still
   launched directly.
7. Propagates the harness's exit code.

Signals (SIGINT, SIGTERM) are forwarded to the child.

### Launch Metadata

Persona launches record metadata by default when the installed backend supports
launcher metadata. AgentWorkforce records:
`agentworkforce=1`, `persona=<id>`, `personaTier=<tier>`,
`personaVersion=<sha256>`, and `personaSource=<cwd|user|dir:n|library>`.
`personaVersion` is the SHA-256 of the fully resolved persona spec after
cascade/extends merge and before prompt input substitution.

Opt out for one launch:

```sh
agentworkforce install @agentworkforce/personas-core --persona code-reviewer
agentworkforce agent --no-launch-metadata code-reviewer@best
```

Opt out through the environment:

```sh
agentworkforce install @agentworkforce/personas-core --persona code-reviewer
AGENTWORKFORCE_LAUNCH_METADATA=0 agentworkforce agent code-reviewer@best
```

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
agentworkforce install @agentworkforce/personas-core --persona code-reviewer
agentworkforce agent --install-in-repo code-reviewer@best
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

## Sandbox mount

By default, claude and opencode interactive sessions run inside a
[`@relayfile/local-mount`](https://www.npmjs.com/package/@relayfile/local-mount)
mount that hides repo-level harness configuration from the session, applies
the persona `mount` block plus Relayfile `.agentignore` / `.agentreadonly`
rules, and routes skill-install writes into the sandbox — so the model sees
persona context + user-level context, and only the project files the mount
exposes. Codex sessions never mount (no harness-side support).

`--install-in-repo` opts out and runs against the real cwd.

The CLI reads these files from the project root before creating the mount:

| File | Effect |
| --- | --- |
| `.agentignore` | Hide matching files for every persona. |
| `.agentreadonly` | Copy matching files into the mount as read-only and skip syncing their edits back. |
| `.<personaId>.agentignore` | Hide matching files only for that persona. |
| `.<personaId>.agentreadonly` | Make matching files read-only only for that persona. |

**What's hidden (gitignore semantics, at any depth):**

For claude:

| Pattern | Rationale |
| --- | --- |
| `CLAUDE.md` | Repo-level project memory |
| `CLAUDE.local.md` | Developer-local project memory |
| `.claude` | Repo Claude Code config dir (settings, agents, skills, commands) |
| `.mcp.json` | Repo-declared MCP servers |

For opencode (skill-install pollution that would otherwise leak back to
the repo):

| Pattern | Rationale |
| --- | --- |
| `.agents`, `.claude/skills`, `.factory/skills`, `.kiro/skills`, `skills` | skill.sh universal install root + per-harness symlink farms |
| `.opencode`, `.skills` | prpm `--as <harness>` output roots |
| `prpm.lock`, `skills-lock.json` | provider lockfiles |

**What's preserved:**

- **User-level context** under `~/.claude/` — `CLAUDE.md`, skills, etc.
  still load. The mount scrubs the *project*, not the user. To exclude
  user-level context too, launch under a scratch `$HOME`.
- **Persona skills.** For claude, the `--plugin-dir` passed to the harness
  resolves to an absolute path *outside* the mount, so staged skills from
  `~/.agent-workforce/sessions/<id>/claude/plugin/` load normally. For
  opencode, the install runs inside the mount so the writes land in the
  sandbox.
- **Keychain auth.** The mount does not pass `--bare`; it only hides
  files. Claude Code's macOS keychain login stays active.
- **Persona `mcpServers`.** Still passed via `--mcp-config` — unaffected
  by the mount. The repo's `.mcp.json` is hidden regardless.
- **Git.** `.git` is included in the mount (one-way project→mount sync per
  `@relayfile/local-mount` 0.6+'s `includeGit`). Tracked paths matching
  the hidden patterns are flagged `skip-worktree` so `git status` doesn't
  report them as deleted, and the patterns are added to `.git/info/exclude`
  to suppress untracked-and-hidden files. Mount-side commits/refs are
  sandboxed and discarded on cleanup — `git push` to persist work.

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
    └── mount/                                     ← session cwd
        └── <mirrored project tree, minus the hidden patterns>
```

`@relayfile/local-mount` handles mount creation, process spawn,
SIGINT/SIGTERM forwarding, write syncback, and cleanup on exit. The
agentworkforce CLI just wires the paths and passes the persona's argv.

### Example

```sh
# Interactive persona session with the repo's CLAUDE.md, .claude/, and
# .mcp.json hidden — session sees the persona's staged skills plus your
# user-level ~/.claude/CLAUDE.md, nothing else from this repo.
agentworkforce install @agentworkforce/personas-core --persona code-reviewer
agentworkforce agent code-reviewer@best
```

On exit: mount is synced back to the real repo, then torn down; skill
stage dir is cleaned up by the existing `rm -rf` cleanup command.

## Selecting a harness per tier

A persona's three tiers can use different harnesses.

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
