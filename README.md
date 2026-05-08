![AgentWorkforce banner](./workforce-readme-banner.png)
<center>Single-purpose AI agent configs, versioned and shared like code. </center>
<br />

Workforce personas are just **a super easy to instantiate** pre-configured harness:
 - choose your coding agent like **Claude Code**, **OpenCode** or **Codex**
 - pick the best **model** and **reasoning** settings
 - define the **skills**, **mcp servers** and **CLAUDE.md** or **AGENTS.MD** prompts
 - pick which files the agent can see and edit
 - save it and share it with your team

 Success with agents relies on making sure they get the right context. With personas, you control the context per instance. As you learn what works in practice you can improve your persona and codify the learnings by committing them to your repository for the rest of the team to use.

The great token squeeze :tm: is coming and you're probably still using opus for everything. Instead of using a sledgehammer to knock in some screws, use an agentworkforce persona to design a screwdriver.

## Quick start
Install a first-party persona pack, then run one of its personas:

```bash
npx agentworkforce install @agentworkforce/personas-core
npx agentworkforce agent frontend-implementer
```

To create a project-specific persona, run:

```bash
npx agentworkforce create
```

This opens the internal `persona-maker` system persona. By default, the new
persona is saved to `./.agentworkforce/workforce/personas` (created if needed).


## Inside a persona

A persona is a JSON file. Top-level fields apply to every tier; the `tiers` block holds per-tier overrides.

| Field | What it defines |
|-------|-----------------|
| `systemPrompt` | The agent's job — what it's for and how it should work |
| `harness` + `model` | Which tool (`claude` / `codex` / `opencode`) and which model |
| `skills` | Capability packages declared by source (prpm, GitHub, `scope/name`); installed at launch into the right harness directory |
| `mcpServers` | External tool servers wired into the session |
| `permissions` | Pre-approved shell + MCP tools; not file scope |
| `mount` | Relayfile ignore/read-only patterns for file visibility and writability |
| `tiers` | `best`, `best-value`, `minimum` — depth and cost dial; same correctness bar |

Tiering controls depth, latency, and cost — **not** the quality bar. A **routing profile** layers on top: policy-only, selects which persona tier to use per intent.

Codex-backed tiers can request Codex launch policy in `harnessSettings`. Use
`"sandboxMode": "workspace-write"` with `"workspaceWriteNetworkAccess": true`
when the persona must run shell commands with outbound network access, such as
registry discovery via `npx`, while keeping filesystem writes sandboxed.

## Examples
Sometimes the quickest way to understand the value of personas is to see real examples. These are intentionally verbose; useful personas tend to grow as teams capture local conventions.

### Next.js marketing website agent
A persona specifically for a Next.js marketing surface. This local overlay
inherits the generic frontend implementer from `@agentworkforce/personas-core`,
switches tiers to Claude so MCP and tool permissions are enforced today, and
attaches a browser MCP for visual checks. File scope is handled by the Relayfile
`mount` block.

```json
{
  "id": "nextjs-marketing",
  "extends": "frontend-implementer",
  "description": "Builds and edits the marketing surface of a Next.js app with SEO, accessibility, and visual QA in scope.",
  "mcpServers": {
    "browser": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--browser", "chrome"]
    }
  },
  "permissions": {
    "allow": [
      "Bash(npm run lint)",
      "Bash(npm run typecheck)",
      "Bash(npm run build)",
      "mcp__browser"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(npm publish *)"
    ],
    "mode": "default"
  },
  "mount": {
    "readonlyPatterns": [
      "*",
      "!app/",
      "!app/(marketing)/",
      "!app/(marketing)/**",
      "!app/page.tsx",
      "!components/",
      "!components/marketing/",
      "!components/marketing/**",
      "!public/",
      "!public/**"
    ]
  },
  "systemPrompt": "You own only the Next.js marketing surface. Work inside app/(marketing), app/page.tsx, components/marketing, and public assets unless the user explicitly expands scope. Preserve existing design-system conventions, metadata, structured data, responsive behavior, accessibility, and Core Web Vitals. Use the browser MCP for visual inspection before completion when a page changes. Output contract: changed files, visual checks performed, commands run, and any SEO or accessibility risks left open.",
  "tiers": {
    "best": {
      "harness": "claude",
      "model": "claude-opus-4-6",
      "harnessSettings": { "reasoning": "high", "timeoutSeconds": 1200 }
    },
    "best-value": {
      "harness": "claude",
      "model": "claude-sonnet-4-6",
      "harnessSettings": { "reasoning": "medium", "timeoutSeconds": 900 }
    },
    "minimum": {
      "harness": "claude",
      "model": "claude-haiku-4-5-20251001",
      "harnessSettings": { "reasoning": "low", "timeoutSeconds": 600 }
    }
  }
}
```

```bash
npx agentworkforce agent nextjs-marketing@best-value
```

### Code Reviewer
Tune the core-pack reviewer for a repo where API compatibility and migration
risk matter more than style commentary. Install `@agentworkforce/personas-core`
first so `code-reviewer` exists in a lower source layer.

```json
{
  "id": "api-reviewer",
  "extends": "code-reviewer",
  "description": "Reviews this repository's changes with extra focus on API compatibility, migrations, and regression risk.",
  "mount": {
    "readonlyPatterns": ["*"]
  },
  "systemPrompt": "Review the current diff for correctness, API compatibility, migration safety, data loss risk, and missing tests. Lead with blockers only; classify other comments as Suggestions or Questions. Ignore formatter-managed style and broad refactors unless they hide a real defect. Output contract: findings ordered by severity with file references, then open questions, then the exact checks you inspected.",
  "tiers": {
    "best": {
      "harnessSettings": { "reasoning": "high", "timeoutSeconds": 1200 }
    },
    "best-value": {
      "harnessSettings": { "reasoning": "medium", "timeoutSeconds": 900 }
    },
    "minimum": {
      "harnessSettings": { "reasoning": "low", "timeoutSeconds": 600 }
    }
  }
}
```

```bash
agentworkforce agent api-reviewer@best-value
```

### Documentation writer
Add a project-specific writer that inherits the technical writer persona, but
binds the docs target through a prompt-visible input. Install
`@agentworkforce/personas-core` first so `technical-writer` exists in a lower
source layer.

```json
{
  "id": "docs-writer",
  "extends": "technical-writer",
  "description": "Updates developer docs for this project using the real code as source of truth.",
  "inputs": {
    "DOCS_PATH": {
      "description": "Primary docs file or directory to update.",
      "env": "DOCS_PATH",
      "default": "docs/"
    }
  },
  "mount": {
    "readonlyPatterns": [
      "*",
      "!docs/",
      "!docs/**"
    ]
  },
  "systemPrompt": "Write or update documentation under $DOCS_PATH. Inspect the implementation before writing, prefer task-focused examples, and call out prerequisites, defaults, and failure modes. Do not invent behavior that is not present in code. Output contract: docs changed, examples added or updated, source files inspected, and caveats."
}
```

```bash
DOCS_PATH=docs/api.md agentworkforce npx agent docs-writer@best-value
```

> [!note]
> Put each persona JSON file at `./.agentworkforce/workforce/personas/<id>.json` or create it with `agentworkforce create`. You can keep Relayfile mount rules in the persona JSON `mount` block, or in project-root `.agentignore` / `.agentreadonly` dotfiles. Launch with `agentworkforce agent <id>@<tier>`.

## CLI

The `agentworkforce` command is the fastest way to actually *run* a persona. It resolves personas from project-local files, configured source directories, and the small internal built-in catalog, installs any declared skills, and execs the harness CLI (`claude`, `codex`, or `opencode`) with the right model, system prompt, env vars, MCP servers, and permissions wired up.

### Install

From npm (recommended):

```bash
npm i -g agentworkforce
```

That puts the `agentworkforce` command on your PATH.

From the monorepo checkout:

```bash
corepack pnpm -r build
corepack pnpm --filter agentworkforce link --global
```

(Or run the built bin directly: `./packages/cli/dist/cli.js …`.)

### Usage

```
agentworkforce create [--save-in-directory=<target>] [--save-default] [--install-in-repo] [--no-launch-metadata]
agentworkforce agent [--install-in-repo] [--no-launch-metadata] <persona>[@<tier>]
agentworkforce list [flags]
agentworkforce install [flags] <pkg|path>
agentworkforce sources <list|add|remove>
agentworkforce harness check
agentworkforce --version
```

- `create` — opens `persona-maker@best` for creating a new persona. By default
  it writes to `./.agentworkforce/workforce/personas/<id>.json` (the directory
  is created if missing); pass `--save-in-directory=<cwd|user|dir:n|library|path>`
  to write somewhere else. The chosen target and create mode are forwarded to
  the persona via `TARGET_DIR` and `CREATE_MODE` inputs.
- `agent` — drops you into an interactive harness session for the persona.
  - `<tier>` is `best` | `best-value` | `minimum` (default: `best-value`).
  - `<persona>` resolves across source layers, highest first:
    1. `./.agentworkforce/workforce/personas/*.json` — project-local
    2. Configured persona source dirs. Default:
       `~/.agentworkforce/workforce/personas/*.json`
    3. Internal built-in system personas in `/personas/` (currently `persona-maker`)
  - Launch metadata is recorded by default for launched sessions; opt out with
    `--no-launch-metadata` or `AGENTWORKFORCE_LAUNCH_METADATA=0`.
- `list` — print the catalog of personas from the cascade (cwd →
  configured dirs → library). Columns: persona, source, harness, model,
  rating, description.
  By default shows one row per persona at the recommended tier for its
  intent. Flags: `--all`, `--json`, `--filter-rating <tier>`,
  `--filter-harness <harness>`, `--no-display-description`. See
  **[packages/cli/README.md](./packages/cli/README.md#list)** for details.
- `install` — copy persona JSON files from an npm package or local package
  directory into `./.agentworkforce/workforce/personas/`. Installed files are
  project-owned and editable. There is no install manifest, lockfile, update
  command, or registry beyond the npm package spec you pass.
- `sources` — list, add, or remove configured persona source directories.
  This is how you include personas installed into another checkout or repo.
  See **[packages/cli/README.md](./packages/cli/README.md#sources)**.
- `harness check` — probe which harnesses (`claude`, `codex`, `opencode`)
  are installed and runnable on this machine. Prints a table with status,
  version, and the resolved path for each.

Each local layer is a *partial overlay* — only the fields you set replace
the value from the next lower layer; everything else cascades through.

### Examples

```bash
agentworkforce create
agentworkforce create --save-in-directory=user
agentworkforce create --save-in-directory=library

# Interactive code reviewer
agentworkforce install @agentworkforce/personas-core --persona code-reviewer
agentworkforce agent code-reviewer@best-value
```

Persona launches record metadata by default when the installed backend supports
launcher metadata. AgentWorkforce records
`agentworkforce=1`, `persona=<id>`, `personaTier=<tier>`,
`personaVersion=<sha256>`, and `personaSource=<cwd|user|dir:n|library>`.
Use `--no-launch-metadata` or `AGENTWORKFORCE_LAUNCH_METADATA=0` to skip
metadata writing and session-log refresh for that launch.

### Persona pack installs

Install a persona pack into the current project:

```bash
agentworkforce install @agentworkforce/personas-core
agentworkforce install @agentworkforce/personas-core@0.8.0 --persona code-reviewer
agentworkforce install @agentrelay/personas
agentworkforce install @agentrelay/personas@1.2.3
agentworkforce install @agentrelay/personas@latest --persona relay-orchestrator
agentworkforce install ./local-personas --persona code-reviewer
```

The command copies matching `*.json` persona files into
`./.agentworkforce/workforce/personas/`, flattening nested package paths to
plain filenames. Existing files are skipped and reported as conflicts by
default; pass `--overwrite` to replace them:

```bash
agentworkforce install @agentrelay/personas --overwrite
```

Persona packs use npm as the distribution mechanism. A package can point at
its persona directory with `package.json` metadata, or fall back to a top-level
`personas/` directory:

```json
{
  "name": "@acme/personas",
  "version": "1.0.0",
  "files": ["personas"],
  "keywords": ["agentworkforce-personas"],
  "agentworkforce": {
    "personas": "personas"
  }
}
```

```text
@acme/personas/
├── package.json
└── personas/
    ├── reviewer.json
    └── release-runner.json
```

First-party examples:

- `@agentworkforce/personas-core` is owned in this repo and contains generic
  personas such as `code-reviewer`, `frontend-implementer`, `verifier`, and
  `test-strategist`.
- `@agentrelay/personas` is owned by the Relay repo and contains Relay-specific
  personas such as `relay-orchestrator`.

`persona-maker` remains part of the internal built-in distribution. You do not
need to install `@agentworkforce/personas-core` before running
`agentworkforce create`.

`install` is a copy utility. Use it when a project should own and edit its
persona files. `sources add <dir>` is separate: it points the cascade at a live
directory and does not copy files.

Worked authoring flow:

```bash
mkdir -p acme-personas/personas
cd acme-personas
npm init -y
npm pkg set name=@acme/personas version=1.0.0
npm pkg set 'files[0]=personas' 'keywords[0]=agentworkforce-personas'
npm pkg set agentworkforce.personas=personas
$EDITOR personas/reviewer.json
npm publish --access public
cd ../my-project
agentworkforce install @acme/personas --persona reviewer
git add .agentworkforce/workforce/personas/reviewer.json
```

### Local persona override

Project-local `./.agentworkforce/workforce/personas/api-reviewer.json`:

```json
{
  "id": "api-reviewer",
  "extends": "code-reviewer",
  "systemPrompt": "Review this repository's API compatibility and migration risks. Lead with blockers."
}
```

This inherits from an installed lower-layer `code-reviewer` persona, then
layers project-specific instructions on top.

The full docs — cascade rules, `${VAR}` interpolation, MCP transport
options, permission grammar, troubleshooting — live in
**[packages/cli/README.md](./packages/cli/README.md)**.

### Skill staging (interactive claude only)

Interactive `claude` sessions stage skills **outside the repo** by default.
The CLI materializes a Claude Code plugin under the user's home directory
and passes it via `--plugin-dir`, so the session sees exactly the persona's
declared skills — and nothing the repo happens to have in `.claude/skills/`.

```
~/.agentworkforce/workforce/
└── sessions/<personaId>-<timestamp>-<rand>/
    └── claude/
        └── plugin/                                ← passed as --plugin-dir
            ├── .claude-plugin/plugin.json         ← generated scaffold
            ├── skills → .claude/skills            ← relative symlink
            └── .claude/skills/<name>/SKILL.md     ← prpm install output
```

On exit the whole stage dir is removed with a single `rm -rf`. To fall back
to the legacy behavior and install into the repo's `.claude/skills/`, pass
`--install-in-repo`:

```bash
agentworkforce install @agentworkforce/personas-core --persona code-reviewer
agentworkforce agent --install-in-repo code-reviewer@best
```

V1 scope: claude interactive only. codex and opencode still use the
repo-relative install path. A content-addressed `~/.agentworkforce/workforce/cache/`
layer for reusing installs across sessions is planned but not yet wired up. See
**[packages/cli/README.md#skill-staging](./packages/cli/README.md#skill-staging)**
for the full mechanics.

### Sandbox mount (default for claude / opencode)

Interactive `claude` and `opencode` sessions launch inside a
[`@relayfile/local-mount`](https://www.npmjs.com/package/@relayfile/local-mount)
sandbox by default. The mount hides repo-level harness configuration
(claude) and routes skill-install writes into the sandbox (opencode), so
the model sees persona context + user-level context — and nothing the
repo itself declares. The mount also enforces Relayfile rules from the
persona's `mount` block plus project-local `.agentignore`, `.agentreadonly`,
`.<personaId>.agentignore`, and `.<personaId>.agentreadonly`. Codex sessions
never mount.

| Hidden in the mount (claude) | Still visible |
| --- | --- |
| `CLAUDE.md` (at any depth) | `~/.claude/CLAUDE.md` (user-level) |
| `CLAUDE.local.md` | `~/.claude/skills/` (user-level skills) |
| `.claude/` | persona's staged skills (via `--plugin-dir`) |
| `.mcp.json` | persona's own `mcpServers` block |
|  | your keychain auth (unchanged) |

Run `agentworkforce agent <id>@<tier>` for any installed/local persona.

The repo tree is mirrored into `~/.agentworkforce/workforce/sessions/<id>/mount/`;
the harness sees the mount as its cwd. Writes inside the mount sync back to
the real repo on exit unless the path is ignored or read-only by Relayfile
rules. Ignore and read-only semantics follow gitignore — `.claude` hides
nested variants like `packages/foo/.claude/` too. `.git` is included in the
mount (one-way project→mount sync) so git commands work inside the sandbox;
mount-side commits are discarded on cleanup, so push to persist work.

**Opt out:** `--install-in-repo` runs against the real cwd and stages
skills into the repo's harness-conventional dirs. Useful when you want to
inspect installed skills on disk or when the mount conflicts with
something else (network filesystem, etc.).

**Caveat:** user-level harness config in `~/.claude/` etc. still loads
inside the session — the mount hides the *repo's* context, not the
user's. If you need to hide user-level config too, launch under a scratch
`$HOME`. See **[packages/cli/README.md#sandbox-mount](./packages/cli/README.md#sandbox-mount)**
for the full mount layout and semantics.

## Packages

- `packages/workload-router` — TypeScript SDK for typed persona + routing profile resolution (harness-agnostic).
- `packages/harness-kit` — Composable primitives for launching a persona's harness: env-ref resolution, MCP server translation, per-harness argv building. The layer the CLI sits on top of. Depend on this directly if you're building your own orchestrator on top of `@agentworkforce/workload-router` and want the same behaviors.
- `packages/cli` — command-line implementation used by the `agentworkforce` wrapper: spawn a persona's harness (claude/codex/opencode) from the shell. See **[packages/cli/README.md](./packages/cli/README.md)** for the full docs, and the [CLI](#cli) section below for a quick tour.

## Personas

- `personas/persona-maker.json`

The built-in catalog is intentionally limited to required internal/system
personas. Optional reusable personas are distributed through persona packs:

- `packages/personas-core/personas/*.json` publishes as `@agentworkforce/personas-core`.
- Relay-specific personas are owned by the Relay repo and publish as `@agentrelay/personas`.

## Routing profiles

- `packages/workload-router/routing-profiles/default.json`
- `packages/workload-router/routing-profiles/schema.json`

## TypeScript SDK usage

For internal system personas, the recommended entry point is
**`usePersona(intent)`** — a synchronous, side-effect-free factory that resolves
a persona and returns grouped install metadata. Calling it does nothing but
pre-compute the routing; nothing is installed or spawned until you run the
install command yourself. Optional pack/local personas should be resolved
through the CLI/source cascade and passed to `useSelection` or
`materializeSkillsFor` as resolved selections.

```ts
import { usePersona } from '@agentworkforce/workload-router';
import { spawnSync } from 'node:child_process';

const { selection, install } = usePersona('persona-authoring');

// Materialize the persona's skills into the repo, then hand `selection`
// (`personaId`, `tier`, `runtime`, `skills`, `rationale`) to your harness
// launcher of choice.
spawnSync(install.commandString, { shell: true, stdio: 'inherit' });
```

> Despite the `use*` prefix, **`usePersona` is not a React hook.** It is a
> plain synchronous factory with no implicit state — safe to call anywhere.

The full return shape is:

```ts
const { selection, install } = usePersona('persona-authoring');
```

- `selection`: resolved persona choice and runtime metadata.
- `install`: grouped install metadata.
- `install.plan`: pure skill-install plan with no side effects.
- `install.command`: full install command as an argv array.
- `install.commandString`: full install command as a shell string.
- `install.cleanupCommand` / `install.cleanupCommandString`: removes the
  ephemeral artifact paths the provider scattered during install (the
  provider lockfile is preserved). For empty plans this is a shell no-op.

For the underlying primitives — `resolvePersona`, `materializeSkillsFor`,
and friends — see
**[`packages/workload-router/README.md`](./packages/workload-router/README.md)**.

## OpenClaw integration pattern

1. Map user request to `intent`:
   - `implement-frontend`
   - `review`
   - `architecture-plan`
   - `requirements-analysis`
   - `debugging`
   - `security-review`
   - `documentation`
   - `verification`
   - `test-strategy`
   - `tdd-enforcement`
   - `flake-investigation`
   - `opencode-workflow-correctness`
   - `npm-provenance`
   - `posthog`
2. Call `usePersona(intent, { profile? })` only for internal built-in personas.
   Optional personas from packs should be loaded by the CLI/source cascade or
   passed to lower-level helpers as resolved selections.
3. Run `install.commandString` to materialize the persona's skills into the
   repo, then spawn the harness CLI yourself with `selection.runtime`. The
   `agentworkforce` CLI is the reference implementation of step 3 — see
   `packages/cli/src/cli.ts`.

`resolvePersona` remains the lower-level resolver for internal built-ins.
`useSelection` and `materializeSkillsFor` are the lower-level primitives for
already-resolved pack/local persona selections.

See runnable mapping example:
- `examples/openclaw-routing.ts`

This keeps runtime configuration in personas, while routing policy stays explicit, typed, and auditable.

## Skills on personas

A persona can declare a `skills` array of reusable capability packages (e.g. from [prpm.dev](https://prpm.dev)):

```json
"skills": [
  {
    "id": "prpm/npm-trusted-publishing",
    "source": "https://prpm.dev/packages/prpm/npm-trusted-publishing",
    "description": "OIDC-based npm publish without long-lived tokens"
  }
]
```

Persona JSON is harness-agnostic — it declares *what* skill is needed, not *how* to install it. The SDK's `materializeSkills(skills, harness)` / `materializeSkillsFor(selection)` helper turns the declaration into a concrete install plan, routing each skill to the right on-disk convention per harness:

| Harness    | Install flag       | Skill directory    |
| ---------- | ------------------ | ------------------ |
| `claude`   | `prpm install --as claude`   | `.claude/skills/` |
| `codex`    | `prpm install --as codex`    | `.agents/skills/` |
| `opencode` | `prpm install --as opencode` | `.agents/skills/` |

Each returned `SkillInstall` carries an argv-style `installCommand`, `installedDir`, and `installedManifest` path. The helper is pure — it never shells out or touches disk — so callers (relay workflows, OpenClaw spawners, ad-hoc scripts) decide how to execute it. Once installed, Claude Code auto-discovers skills from `.claude/skills/`; for other harnesses, read the manifest off disk and inject it into the agent's task body.

## Eval framework (scaffold direction)

Next step is a benchmark harness to score persona/tier combinations on:

- quality (task pass rate)
- cost
- latency

Then publish a versioned “recommended tier map” so default routing is data-backed.

## Quick start

```bash
corepack enable
pnpm install
pnpm run check
```

This runs minimal guardrails across the workspace:

- `lint` (currently TypeScript-only)
- `typecheck` (package + examples)
- `test` (Node test runner)

## Developing

For iterating on the CLI, harness-kit, workload-router, or internal system persona JSON files,
use the watch-mode dev loop instead of rebuilding by hand.

**Terminal 1 — start the watchers (leave running):**

```bash
npm run dev
```

First runs a cold `corepack pnpm -r build` so every package's `dist/` exists,
then starts `tsc --watch` on all three packages in parallel. For
`workload-router` it also runs a persona-JSON watcher: editing any internal
system file under `/personas/*.json` regenerates
`packages/workload-router/src/generated/personas.ts`, and tsc picks up the
change and rebuilds dist automatically — full JSON → built artifact flow with
no manual step.

**Terminal 2 — invoke the CLI against the latest build:**

```bash
npm run dev:cli -- harness check
npm run dev:cli -- agent code-reviewer@best-value "look at the diff on this branch"
```

The `--` is required so npm forwards everything after it as argv to the CLI
(otherwise npm consumes flags like `--model` for itself).

Edit → save → re-run in terminal 2. TypeScript errors show up in terminal 1.

**Per-package dev:** if you only want to watch one package, run
`corepack pnpm --filter @agentworkforce/<name> run dev` (where `<name>` is
`cli`, `harness-kit`, or `workload-router`).
