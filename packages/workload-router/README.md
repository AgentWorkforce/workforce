# @agentworkforce/workload-router

Routing and profile utilities for AgentWorkforce workload orchestration.

## Install

```bash
npm install @agentworkforce/workload-router
```

## Usage

### `usePersona(intent, options?)`

Despite the `use*` prefix, **this is not a React hook.** It is a plain
synchronous factory: call it, get back a `PersonaContext` bundling the
resolved persona, its skill install plan, and an `execute()` closure.
Nothing is installed, spawned, or written to disk until you call
`execute()` (or run the install command yourself).

```ts
import { usePersona } from '@agentworkforce/workload-router';
```

There are **two usage modes**, and they are alternatives — not sequential
steps. Pick one.

#### Mode A — let `execute()` install skills and run the agent (recommended)

```ts
const { execute } = usePersona('npm-provenance');

const result = await execute('Set up npm trusted publishing for this repo', {
  workingDirectory: '.',
  timeoutSeconds: 600,
});

if (result.status !== 'completed') {
  console.error('persona run failed', result.status, result.stderr);
}
```

`execute()` builds an ad-hoc agent-relay workflow with two steps: (1)
`prpm install` the persona's skills, then (2) invoke the persona's harness
agent with your task. `installSkills` defaults to `true`, so the first step
runs automatically — no manual install needed.

#### Mode B — pre-stage install out-of-band, then run without re-install

```ts
import { spawnSync } from 'node:child_process';

const { installCommandString, execute } = usePersona('npm-provenance');

// build time (Dockerfile RUN, CI bootstrap step, first-run setup, etc.):
spawnSync(installCommandString, { shell: true, stdio: 'inherit' });

// runtime — skip re-install because skills are already staged:
const result = await execute('Your task', {
  workingDirectory: '.',
  installSkills: false,
});
```

Use Mode B when you want to install skills once at build/CI time for
caching, hermeticity, offline runtime, or split-trust reasons — or when you
want to wrap the install with your own process management (custom timeout,
logging, retry, alternative runner, etc.).

A third usage is **install-only**: if all you want is to materialize the
persona's skills into the repo for a human or another tool to use, run
`installCommandString` and never call `execute()`.

> ⚠️ **Do not combine the two modes without `installSkills: false`.**
> Running `spawnSync(installCommandString, ...)` *and then* calling
> `execute(task)` without passing `installSkills: false` will install the
> persona's skills **twice**. `ExecuteOptions.installSkills` defaults to
> `true`, so you must explicitly opt out when you have already pre-staged.

#### Cancellation, streaming progress, and the run id

```ts
const abort = new AbortController();
const run = usePersona('npm-provenance').execute('Your task', {
  signal: abort.signal,
  onProgress: ({ stream, text }) => process[stream].write(text),
});

run.runId.then((id) => console.log('workflow run id:', id));

// ...later, from another code path:
abort.abort();           // or: run.cancel('user requested');

const result = await run; // ExecuteResult — note: settled, not thrown,
                          // even when status is 'cancelled' / 'failed' / 'timeout'.
```

`run.runId` is a `Promise<string>` — it is *not* available synchronously
when `execute()` returns, because the workflow hasn't started yet. It
resolves once the persona's agent step has actually spawned (on the first
progress event from the subprocess, or ~250ms after spawn as a safety net).
Don't block on it in a tight synchronous path expecting a cached value.

## Development

```bash
pnpm --filter @agentworkforce/workload-router build
pnpm --filter @agentworkforce/workload-router test
```
