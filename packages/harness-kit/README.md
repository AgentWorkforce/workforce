# @agentworkforce/harness-kit

Composable primitives for spawning a persona's harness (claude, codex,
opencode) with its MCP servers, env vars, and permissions wired up correctly.

This is the layer that `@agentworkforce/cli` sits on top of. If you're
building your own orchestrator on top of `@agentworkforce/workload-router`
and want the same behaviors the CLI provides — env-ref resolution, MCP
isolation, permission flag translation — depend on this package rather than
reimplementing them.

> The router (`@agentworkforce/workload-router`) models **what** a persona
> is. This kit models **how to launch it** on a given harness. Both are
> harness-agnostic on their own; the per-harness knowledge lives here.

## Install

```sh
pnpm add @agentworkforce/harness-kit @agentworkforce/workload-router
```

## What's in the box

### `buildInteractiveSpec(input)` — translate a persona to a spawnable argv

Takes the fields off a `PersonaSelection` (harness, model, systemPrompt,
mcpServers, permissions) and returns `{bin, args, initialPrompt, warnings}`.
Pure — no I/O, no stderr writes. Warnings are returned so your caller routes
them wherever makes sense.

```ts
import { resolvePersona } from '@agentworkforce/workload-router';
import {
  buildInteractiveSpec,
  resolveMcpServersLenient,
  resolveStringMapLenient,
  formatDropWarnings
} from '@agentworkforce/harness-kit';
import { spawn } from 'node:child_process';

const selection = resolvePersona('posthog');

// Resolve env + MCP refs against the current process environment. Missing
// refs don't throw — they come back on `.dropped` so you can warn the user.
const envResolution = resolveStringMapLenient(selection.env, process.env, 'env');
const mcpResolution = resolveMcpServersLenient(selection.mcpServers, process.env);

const warnings = formatDropWarnings(
  envResolution.dropped,
  mcpResolution.dropped,
  mcpResolution.droppedServers
);
for (const w of warnings) console.warn(w);

// Build the exec spec.
const spec = buildInteractiveSpec({
  harness: selection.runtime.harness,
  model: selection.runtime.model,
  systemPrompt: selection.runtime.systemPrompt,
  mcpServers: mcpResolution.servers,
  permissions: selection.permissions
});
for (const w of spec.warnings) console.warn(w);

// Spawn the harness.
const args = spec.initialPrompt ? [...spec.args, spec.initialPrompt] : [...spec.args];
spawn(spec.bin, args, {
  stdio: 'inherit',
  env: { ...process.env, ...(envResolution.value ?? {}) }
});
```

### Claude harness guarantees

When `harness === 'claude'`, `buildInteractiveSpec` **always** emits both:

- `--mcp-config '{"mcpServers": …}'` — even if empty
- `--strict-mcp-config` — forces Claude Code to ignore user/project MCP sources

This means a persona session only sees MCP servers the persona itself
declares. Your `~/.claude.json` and any project `.claude/` MCP config are
invisible inside the session. That's the whole point of persona isolation;
if you want a personal MCP in the session, declare it on the persona.

### Codex / opencode

Current state: these harnesses don't expose runtime MCP injection or
permission controls on their CLIs. `buildInteractiveSpec` carries the
system prompt as the initial positional `[PROMPT]` argument (since
neither has a `--system-prompt` flag) and returns a warning string if the
persona declares `mcpServers` or `permissions`. The caller decides whether
to print, fail, or continue.

## Env reference resolution

The kit supports two forms of env references inside persona JSON:

| Form | Semantics |
| ---- | --------- |
| `"$VAR"`           | Whole-string reference. The entire value is replaced. |
| `"Bearer ${VAR}"`  | Braced; each `${VAR}` is interpolated in place. |

Unbraced `$VAR` *mid-string* is kept as a literal — this prevents a stray
`$` in a JSON value from accidentally being treated as a reference, and it
keeps missing-var errors pointed at a specific field name.

### Two resolution policies

Pick the one that matches your error-handling preference:

| Function | Missing ref → | Use when |
| -------- | ------------- | -------- |
| `makeEnvRefResolver(env)` / `resolveStringMap(map, env, prefix)` | throws `MissingEnvRefError` | You want fail-fast — e.g. CI scripts where a missing secret is a configuration bug. |
| `makeLenientResolver(env)` / `resolveStringMapLenient(map, env, prefix)` | returns `{ok:false, field, ref}` (or drops the entry on the `Lenient` map helper) | You want graceful fallback — e.g. letting an MCP server authenticate via OAuth if the Bearer token isn't set. |

The CLI uses the lenient path; it drops missing env entries and unset MCP
headers with a warning, and only aborts if a *structural* field (`url`,
`command`, any `arg`) can't be resolved.

## API surface

```ts
// Env refs
export class MissingEnvRefError extends Error { ref: string; referencedBy: string }
export function makeEnvRefResolver(env): (value, field) => string
export function makeLenientResolver(env): (value, field) => LenientResult
export function resolveStringMap(map, env, prefix): Record<string,string> | undefined
export function resolveStringMapLenient(map, env, prefix): { value, dropped: DroppedRef[] }
export type LenientResult = { ok: true; value: string } | { ok: false; field: string; ref: string }
export interface DroppedRef { field: string; ref: string }

// MCP
export function resolveMcpServersLenient(servers, env): McpResolution
export function formatDropWarnings(envDrops, mcpDrops, mcpServerDrops): string[]
export interface McpResolution {
  servers: Record<string, McpServerSpec> | undefined;
  dropped: DroppedRef[];
  droppedServers: DroppedMcpServer[];
}
export interface DroppedMcpServer { name: string; refs: string[] }

// Harness
export function buildInteractiveSpec(input: BuildInteractiveSpecInput): InteractiveSpec
export interface BuildInteractiveSpecInput {
  harness: Harness;
  model: string;
  systemPrompt: string;
  mcpServers?: Record<string, McpServerSpec>;
  permissions?: PersonaPermissions;
}
export interface InteractiveSpec {
  bin: string;
  args: readonly string[];
  initialPrompt: string | null;
  warnings: string[];
}
```

## Status

Small, stable surface focused on the three things a harness spawner needs:
resolve env refs, resolve MCP config, build argv. It does **not** spawn
processes, manage stdio, install skills, or talk to the filesystem — those
live in the CLI because different consumers will want different behaviors
there (CI pipelines, IDE plugins, test harnesses, etc.).

A future `useSelection().run()` convenience in the router may wrap these
helpers into a one-liner — if that happens, it'll be built on top of this
package, not a replacement for it.
