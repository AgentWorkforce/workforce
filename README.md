# workforce

Shared AgentWorkforce primitives for persona-driven orchestration.

## Core frame

A **persona** is the runtime source of truth:

- prompt (`systemPrompt`)
- model
- harness
- harness settings
- optional `skills` array of `{ id, source, description }` entries for reusable capability guidance (e.g. prpm.dev packages)

Each persona supports service tiers:

- `best`
- `best-value`
- `minimum`

Tiering controls depth, latency budget, and model cost envelope — **not** the quality bar.
All tiers should enforce the same correctness/safety standards; lower tiers should be more concise, not lower-quality.

A **routing profile** is policy-only. It does not carry runtime fields; it only selects which persona tier to use per intent and explains why.

## CLI

The `agent-workforce` binary (published as `@agentworkforce/cli`) is the
fastest way to actually *run* a persona. It resolves the persona from the
built-in catalog or your local overrides, installs any declared skills,
and execs the harness CLI (`claude`, `codex`, or `opencode`) with the right
model, system prompt, env vars, MCP servers, and permissions wired up.

### Install

From the monorepo checkout:

```bash
corepack pnpm -r build
corepack pnpm --filter @agentworkforce/cli link --global
```

`agent-workforce` is now on your PATH. (Or run the built bin directly:
`./packages/cli/dist/cli.js …`.)

### Usage

```
agent-workforce agent <persona>[@<tier>] [task...]
agent-workforce list [flags]
agent-workforce harness check
```

- `agent` — run a persona.
  - **No task** → drops you into an interactive harness session.
  - **Task string** → runs one-shot via `usePersona().sendMessage()` and
    streams output.
  - `<tier>` is `best` | `best-value` | `minimum` (default: `best-value`).
  - `<persona>` resolves across three layers, highest first:
    1. `./.agent-workforce/*.json` — project-local
    2. `~/.agent-workforce/*.json` — user-local
    3. Built-in personas in `/personas/`
- `list` — print the catalog of personas from the cascade (pwd → home →
  library). Columns: persona, source, harness, model, rating, description.
  By default shows one row per persona at the recommended tier for its
  intent. Flags: `--all`, `--json`, `--filter-rating <tier>`,
  `--filter-harness <harness>`, `--no-display-description`. See
  **[packages/cli/README.md](./packages/cli/README.md#list)** for details.
- `harness check` — probe which harnesses (`claude`, `codex`, `opencode`)
  are installed and runnable on this machine. Prints a table with status,
  version, and the resolved path for each.

Each local layer is a *partial overlay* — only the fields you set replace
the value from the next lower layer; everything else cascades through.

### Examples

```bash
# One-shot against the built-in code reviewer
agent-workforce agent review@best-value "look at the diff on this branch"

# Interactive PostHog session — the built-in persona ships with the PostHog
# MCP server wired up and its tools auto-approved.
export POSTHOG_API_KEY=phx_…
agent-workforce agent posthog@best
```

### Local persona override

Project-local `./.agent-workforce/my-posthog.json`:

```json
{
  "id": "my-posthog",
  "extends": "posthog",
  "env": { "POSTHOG_API_KEY": "$POSTHOG_API_KEY" },
  "permissions": {
    "allow": ["mcp__posthog__insights-list", "mcp__posthog__events-query"]
  }
}
```

`agent-workforce agent my-posthog@best` inherits everything from the built-in
`posthog` persona, layers your env var and narrower allow list on top, and
launches claude against the PostHog MCP server with only the two named tools
auto-approved.

The full docs — cascade rules, `${VAR}` interpolation, MCP transport
options, permission grammar, troubleshooting — live in
**[packages/cli/README.md](./packages/cli/README.md)**.

### Skill staging (interactive claude only)

Interactive `claude` sessions stage skills **outside the repo** by default.
The CLI materializes a Claude Code plugin under the user's home directory
and passes it via `--plugin-dir`, so the session sees exactly the persona's
declared skills — and nothing the repo happens to have in `.claude/skills/`.

```
~/.agent-workforce/
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
agent-workforce agent --install-in-repo code-reviewer@best
```

V1 scope: claude interactive only. codex, opencode, and one-shot runs still
use the repo-relative install path. A content-addressed
`~/.agent-workforce/cache/` layer for reusing installs across sessions is
planned but not yet wired up. See
**[packages/cli/README.md#skill-staging](./packages/cli/README.md#skill-staging)**
for the full mechanics.

### Clean mode (`--clean`)

For interactive `claude` sessions, `--clean` launches the harness inside a
[`@relayfile/local-mount`](https://www.npmjs.com/package/@relayfile/local-mount)
sandbox that hides repo-level Claude Code configuration from the model:

| Hidden in `--clean` mode | Still visible |
| --- | --- |
| `CLAUDE.md` (at any depth) | `~/.claude/CLAUDE.md` (user-level) |
| `CLAUDE.local.md` | `~/.claude/skills/` (user-level skills) |
| `.claude/` | persona's staged skills (via `--plugin-dir`) |
| `.mcp.json` | persona's own `mcpServers` block |
|  | your keychain auth (unchanged) |

```bash
agent-workforce agent --clean posthog@best
```

The repo tree is mirrored into
`~/.agent-workforce/sessions/<id>/mount/` via symlinks; claude sees the
mount as its cwd. Writes inside the mount sync back to the real repo on
exit. Ignore semantics follow gitignore — `.claude` hides nested variants
like `packages/foo/.claude/` too.

**Scope:** interactive claude only. Pass it to codex/opencode or to a
one-shot run and the flag is ignored with a note. `--clean` and
`--install-in-repo` are mutually exclusive — they ask for opposite things.

**Caveat:** user-level Claude Code config in `~/.claude/` still loads
inside the session. `--clean` hides the *repo's* context, not the user's.
If you need to hide user-level config too, launch under a scratch
`$HOME`. See **[packages/cli/README.md#clean-mode](./packages/cli/README.md#clean-mode)**
for the full mount layout and semantics.

## Packages

- `packages/workload-router` — TypeScript SDK for typed persona + routing profile resolution (harness-agnostic).
- `packages/harness-kit` — Composable primitives for launching a persona's harness: env-ref resolution, MCP server translation, per-harness argv building. The layer the CLI sits on top of. Depend on this directly if you're building your own orchestrator on top of `@agentworkforce/workload-router` and want the same behaviors.
- `packages/cli` — `agent-workforce` command-line front end: spawn a persona's harness (claude/codex/opencode) from the shell, interactively or one-shot. See **[packages/cli/README.md](./packages/cli/README.md)** for the full docs, and the [CLI](#cli) section below for a quick tour.

## Personas

- `personas/agent-relay-workflow.json`
- `personas/frontend-implementer.json`
- `personas/code-reviewer.json`
- `personas/architecture-planner.json`
- `personas/requirements-analyst.json`
- `personas/debugger.json`
- `personas/security-reviewer.json`
- `personas/technical-writer.json`
- `personas/verifier.json`
- `personas/test-strategist.json`
- `personas/tdd-guard.json`
- `personas/flake-hunter.json`
- `personas/opencode-workflow-specialist.json`
- `personas/npm-provenance-publisher.json`
- `personas/posthog.json`
- `personas/persona-maker.json`
- `personas/anti-slop-auditor.json`
- `personas/api-contract-reviewer.json`
- `personas/docker-stack-wrangler.json`
- `personas/e2e-validator.json`
- `personas/integration-test-author.json`
- `personas/npm-package-bundler-guard.json`

## Routing profiles

- `packages/workload-router/routing-profiles/default.json`
- `packages/workload-router/routing-profiles/schema.json`

## TypeScript SDK usage

The recommended entry point is **`usePersona(intent)`** — a synchronous,
side-effect-free factory that resolves a persona and returns grouped install
metadata plus a `sendMessage()` closure. Calling it does nothing but
pre-compute the routing; nothing is installed or spawned until you call
`sendMessage()` or run the install command yourself.

```ts
import { usePersona } from '@agentworkforce/workload-router';

const { sendMessage } = usePersona('npm-provenance');

// Installs the persona's skills, then runs the persona's harness agent
// with your task. Returns a PersonaExecution — awaitable, with
// `cancel()` and a `runId` promise attached.
//
// `await sendMessage(...)` only resolves on `status: 'completed'`. Non-zero
// exits / timeouts throw PersonaExecutionError; cancellation throws
// AbortError. Both carry the typed ExecuteResult on `err.result`.
try {
  const result = await sendMessage('Set up npm trusted publishing for this repo', {
    workingDirectory: '.',
    timeoutSeconds: 600,
  });
  // result.status === 'completed' here
} catch (err) {
  const execErr = err as Error & {
    result?: { status: string; stderr: string; exitCode: number | null };
  };
  console.error(
    'persona run failed',
    execErr.result?.status,
    execErr.result?.stderr,
  );
}
```

> Despite the `use*` prefix, **`usePersona` is not a React hook.** It is a
> plain synchronous factory with no implicit state — safe to call anywhere.

The full return shape is:

```ts
const {
  selection,
  install,
  sendMessage,
} = usePersona('npm-provenance');
```

- `selection`: resolved persona choice and runtime metadata.
- `install`: grouped install metadata.
- `install.plan`: pure skill-install plan with no side effects.
- `install.command`: full install command as an argv array.
- `install.commandString`: full install command as a shell string.
- `sendMessage(task, options?)`: runs the persona and returns an awaitable `PersonaExecution`.

For the full API — the install-only mode, pre-staged install with
`installSkills: false`, cancellation via `AbortSignal`, streaming progress,
the `runId` timing contract, and the double-install caveat when mixing
modes — see **[`packages/workload-router/README.md`](./packages/workload-router/README.md)**.

<details>
<summary>Low-level primitives (advanced use — prefer <code>usePersona</code> for new code)</summary>

If you need to resolve a persona and materialize its skill install plan
**without** running an agent — or you want to drive install yourself with
custom process management — `usePersona` is built on top of two pure
helpers you can call directly:

```ts
import { resolvePersona, materializeSkillsFor } from '@agentworkforce/workload-router';
import { spawnSync } from 'node:child_process';

const selection = resolvePersona('npm-provenance');
// selection -> { personaId, tier, runtime, skills, rationale }

const plan = materializeSkillsFor(selection);
for (const install of plan.installs) {
  // install.installCommand is an argv array (safer for execFile/spawn).
  // For a shell string, use `usePersona(...).install.commandString`.
  spawnSync(install.installCommand[0], install.installCommand.slice(1), { stdio: 'inherit' });
}
```

These primitives are exported for callers who need direct access to the
plan object or want to skip the `sendMessage()` workflow entirely. New code
should prefer `usePersona` — it consolidates routing, install planning,
and agent execution into one call and gives you cancellation / progress /
run-id observability for free.

</details>

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
2. Call `usePersona(intent, { profile? })` to resolve the persona and
   receive the selected persona, grouped install metadata, and a
   `sendMessage()` closure bound to its runtime (harness, model, settings,
   prompt).
3. Call `sendMessage(task, opts)` to install the persona's skills and invoke
   its harness agent in one step. Use `AbortSignal` / `execution.cancel()`
   for cancellation and `onProgress` to stream stdout/stderr.

If you need to bypass `sendMessage()` and spawn the agent yourself — for
example, to integrate with an existing orchestrator — `resolvePersona` +
`materializeSkillsFor` remain available as the underlying primitives
(see the collapsed section above).

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

For iterating on the CLI, harness-kit, workload-router, or persona JSON files,
use the watch-mode dev loop instead of rebuilding by hand.

**Terminal 1 — start the watchers (leave running):**

```bash
npm run dev
```

First runs a cold `corepack pnpm -r build` so every package's `dist/` exists,
then starts `tsc --watch` on all three packages in parallel. For
`workload-router` it also runs a persona-JSON watcher: editing any file under
`/personas/*.json` regenerates
`packages/workload-router/src/generated/personas.ts`, and tsc picks up the
change and rebuilds dist automatically — full JSON → built artifact flow with
no manual step.

**Terminal 2 — invoke the CLI against the latest build:**

```bash
npm run dev:cli -- harness check
npm run dev:cli -- agent review@best-value "look at the diff on this branch"
```

The `--` is required so npm forwards everything after it as argv to the CLI
(otherwise npm consumes flags like `--model` for itself).

Edit → save → re-run in terminal 2. TypeScript errors show up in terminal 1.

**Per-package dev:** if you only want to watch one package, run
`corepack pnpm --filter @agentworkforce/<name> run dev` (where `<name>` is
`cli`, `harness-kit`, or `workload-router`).
