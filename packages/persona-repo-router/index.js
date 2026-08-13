import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The repo-router persona spec. A codebase navigator that maps all sibling
 * repos in the AgentWorkforce ecosystem, determines which repo(s) an issue
 * requires changes in, and spawns codex implementer + claude reviewer agents
 * pointed at the correct repos. Handles multi-repo issues by splitting work
 * across parallel implementers.
 *
 * Source of truth: `personas/repo-router.json` (with its `repo-router.md`
 * agentsMd sidecar).
 */
const persona = require('./personas/repo-router.json');

export const repoRouterPersona = persona;

export default persona;
