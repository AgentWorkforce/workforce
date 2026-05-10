# @agentworkforce/persona-kit

Persona-kit owns the AgentWorkforce persona instantiation lifecycle. See tracking issue [#64](https://github.com/AgentWorkforce/workforce/issues/64).

## Top-level orchestration API

The package exposes a two-phase API: a **pure plan builder** that composes a
persona's runtime data into a single inspectable value, and a **side-effecting
executor** that runs the plan and returns a handle that reverses every side
effect.

### Persona JSON → running agent (end-to-end)

```ts
import {
  buildPersonaSpawnPlan,
  executePersonaSpawnPlan,
  type ResolvedPersona
} from '@agentworkforce/persona-kit';
import { spawn } from 'node:child_process';

declare const persona: ResolvedPersona; // from loadPersonas() / personaCatalog

// 1. Compose a plan. Pure — no I/O, no subprocesses.
const plan = buildPersonaSpawnPlan(persona, {
  cwd: process.cwd(),
  inputValues: { TASK: 'tidy up the README' }
});

// 2. Inspect or stamp the plan if you like — it's JSON-serializable.
console.log(plan.cli, plan.args, plan.env);

// 3. Run the side effects. Returns a handle whose dispose() reverses them.
const handle = await executePersonaSpawnPlan(plan, { cwd: process.cwd() });

try {
  // 4. Spawn the harness at handle.cwd with plan.cli + plan.args + plan.env.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.cli, plan.args, {
      cwd: handle.cwd,
      env: plan.env,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('close', () => resolve());
  });
} finally {
  // 5. Tear down: removes installed skills, restores sidecar files,
  //    cleans up materialized config files, releases the mount.
  await handle.dispose();
}
```

### Plan structure

`PersonaSpawnPlan` carries everything a caller needs:

- `persona` — the resolved persona (model, harness, skills, env, …).
- `cli`, `args`, `initialPrompt` — what to spawn.
- `env` — final environment with input bindings + persona env merged in.
- `skills` — pure `SkillMaterializationPlan` produced by `materializeSkills`.
- `mount`, `sidecars`, `configFiles`, `inputs` — resolved pieces ready for
  the executor.

The plan is **JSON-serializable** — useful for stamping into launch metadata
or sending across a wire (e.g. relay's `getPersonaSpawnPlan`).

### Piecewise helpers

For callers who want their own orchestration:

- `applyPersonaMount(mount, options)` — opens an `@relayfile/local-mount`
  sandbox when a mount policy is supplied, no-op otherwise. Returns a handle
  exposing the harness `cwd`.
- `runSkillInstalls(plan, options)` — spawns the install commands produced
  by `buildInstallArtifacts`. Aborts on the first non-zero exit and attaches
  the buffered subprocess output to `SkillInstallError`.
- `writePersonaSidecars(sidecars, options)` — writes `CLAUDE.md` /
  `AGENTS.md` with restore-on-dispose semantics.
- `materializePersonaConfigFiles(configFiles, options)` — writes the harness
  config files (e.g. `opencode.json`) with restore-on-dispose semantics.

Each helper returns a handle of shape `{ dispose(): Promise<void> }`.
`executePersonaSpawnPlan` composes them in order: mount → skills → sidecars
→ config files. If any step throws, prior handles are disposed in LIFO
order before the original error propagates.

### Pure lower-level helpers

`buildInteractiveSpec`, `materializeSkills`, `parsePersonaFile`,
`resolvePersonaInputs`, etc. remain available for advanced callers who want
finer control than the plan builder offers.
