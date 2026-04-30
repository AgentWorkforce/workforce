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
resolved persona and grouped install metadata. Nothing is installed,
spawned, or written to disk — run `install.commandString` yourself when
you are ready to materialize the persona's skills.

```ts
import { usePersona } from '@agentworkforce/workload-router';
```

#### Return shape

```ts
const { selection, install } = usePersona('npm-provenance');
```

- `selection`: the resolved persona choice for the given intent/profile. Includes `personaId`, `tier`, `runtime`, `skills`, and `rationale`.
- `install`: grouped install metadata.
- `install.plan`: a pure description of what skill installs would be needed for that persona on that harness. No processes run when you read this.
- `install.command`: the full install command as an argv array for `spawn`/`execFile`.
- `install.commandString`: the same full install command as a shell-escaped string.
- `install.cleanupCommand` / `install.cleanupCommandString`: a `rm -rf` over the ephemeral artifact paths the provider scatters during install (the provider's lockfile is deliberately preserved). For empty plans this is a shell no-op (`:`). Run it after the agent has consumed the skills.

#### Example

```ts
import { spawnSync } from 'node:child_process';
import { usePersona } from '@agentworkforce/workload-router';

const { selection, install } = usePersona('npm-provenance');

spawnSync(install.commandString, { shell: true, stdio: 'inherit' });
// hand `selection` to your harness launcher of choice.
```

## Development

```bash
pnpm --filter @agentworkforce/workload-router build
pnpm --filter @agentworkforce/workload-router test
```
