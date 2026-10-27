import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The autonomous-actor persona spec. An autonomous orchestrator for delegated,
 * multi-PR, multi-day, cutover-class infra/feature delivery, operating under an
 * explicit written contract (auto-merge / flip / swarm / rollback authority)
 * with standing constraints and escalate-to-human gates.
 *
 * Source of truth: `personas/autonomous-actor.json`. This compatibility export
 * keeps programmatic consumers working while the package also acts as an
 * AgentWorkforce installable persona pack.
 */
const persona = require('./personas/autonomous-actor.json');

export const autonomousActorPersona = persona;

export default persona;
