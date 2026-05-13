# @agentworkforce/daytona-runner

Daytona-backed `WorkflowRuntime` adapter for AgentWorkforce deploy workflows. This package owns the Daytona runtime implementation, auth helpers, and runtime contract types.

## Install

```sh
npm install @agentworkforce/daytona-runner @daytonaio/sdk
```

`@daytonaio/sdk` is a peer dependency — consumers bring their own version (^0.148.0).

## Usage

```ts
import { Daytona } from '@daytonaio/sdk';
import {
  DaytonaRuntime,
  resolveDaytonaAuthCredentials,
} from '@agentworkforce/daytona-runner';

const auth = resolveDaytonaAuthCredentials({
  apiKey: process.env.DAYTONA_API_KEY,
  jwtToken: process.env.DAYTONA_JWT_TOKEN,
  organizationId: process.env.DAYTONA_ORGANIZATION_ID,
});

const daytona = new Daytona(auth);
const runtime = new DaytonaRuntime({ daytona });

const handle = await runtime.launch({ label: 'my-workflow' });
const result = await runtime.exec(handle, 'node -e "console.log(\\"ok\\")"');
await runtime.destroy(handle);
```

## Exports

- `DaytonaRuntime` — the `WorkflowRuntime` implementation.
- `resolveDaytonaAuthCredentials` / `applyDaytonaAuthEnv` — Daytona auth helpers (apiKey vs JWT+org).
- `WorkflowRuntime`, `RuntimeHandle`, `LaunchOptions`, `ExecOptions`, `ExecResult`, `RuntimeCapabilities` — runtime contract types.
