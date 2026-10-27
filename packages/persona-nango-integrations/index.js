import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The nango-integrations persona spec. The persona builds and maintains Nango
 * TypeScript integrations and their Cloud-side Relayfile wiring.
 *
 * Source of truth: `personas/nango-integrations.json`. This compatibility
 * export keeps existing programmatic consumers working while the package also
 * acts as an AgentWorkforce installable persona pack.
 */
const persona = require('./personas/nango-integrations.json');

export const nangoIntegrationsPersona = persona;

export default persona;
