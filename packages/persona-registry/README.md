# @agentworkforce/persona-registry

Programmatic resolution for AgentWorkforce personas. It owns the same source
cascade used by the CLI: cwd personas, cwd agents, configured directories
(including the personal directory), personal agents, then the built-in catalog.

```ts
import { resolvePersonaReference } from '@agentworkforce/persona-registry';

const resolved = resolvePersonaReference('persona-maker', { cwd: process.cwd() });
console.log(resolved.selection.harness, resolved.selection.model);
```

`resolvePersonaReference` accepts a persona id, built-in intent, or JSON path.
It returns both the merged `PersonaSpec` and the interactive
`PersonaSelection` consumed by `@agentworkforce/persona-kit`'s spawn-plan SDK.
