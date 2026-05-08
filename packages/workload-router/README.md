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

- `selection`: the resolved persona choice for the given intent/profile. Includes `personaId`, `tier`, `runtime`, `skills`, `inputs`, `mount`, and `rationale`.
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

## Persona shape

Personas may declare prompt-visible runtime inputs:

```jsonc
{
  "id": "release-checker",
  "intent": "release-check",
  "tags": ["release"],
  "description": "Checks release readiness.",
  "skills": [],
  "inputs": {
    "PACKAGE_NAME": {
      "description": "Package or workspace to inspect.",
      "env": "PACKAGE_NAME",
      "default": "."
    },
    "REPORT_PATH": "release-report.md"
  },
  "mount": {
    "readonlyPatterns": ["*", "!docs/**"]
  },
  "tiers": {
    "best": {
      "harness": "codex",
      "model": "openai-codex/gpt-5.3-codex",
      "systemPrompt": "Check $PACKAGE_NAME and write ${REPORT_PATH}.",
      "harnessSettings": {
        "reasoning": "high",
        "timeoutSeconds": 1200,
        "sandboxMode": "workspace-write",
        "workspaceWriteNetworkAccess": true
      }
    }
    // best-value and minimum omitted in this fragment
  }
}
```

Input keys must be env-style uppercase names. The router validates and carries
the declarations through `PersonaSpec` and `PersonaSelection`; launchers decide
how to resolve and render them. The standard harness-kit policy is explicit
value, env var, default, then fail.

Codex runtimes may also set `harnessSettings.sandboxMode`,
`harnessSettings.approvalPolicy`,
`harnessSettings.workspaceWriteNetworkAccess`, and
`harnessSettings.webSearch`; harness-kit maps those to Codex launch flags.

## Development

```bash
pnpm --filter @agentworkforce/workload-router build
pnpm --filter @agentworkforce/workload-router test
```
