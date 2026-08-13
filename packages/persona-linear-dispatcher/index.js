import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The linear-dispatcher persona spec. An autonomous Linear issue dispatcher
 * that watches for issues in the Ready for Agent state, triages them, dispatches
 * codex implementer agents and claude reviewer agents in batches of 5, posts
 * comments on issues, and updates state to Agent Implementing.
 *
 * Source of truth: `personas/linear-dispatcher.json` (with its
 * `linear-dispatcher.md` agentsMd sidecar). This compatibility export keeps
 * programmatic consumers working while the package also acts as an
 * AgentWorkforce installable persona pack.
 */
const persona = require('./personas/linear-dispatcher.json');

export const linearDispatcherPersona = persona;

export default persona;
